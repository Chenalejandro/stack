import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { getAuthContactChannel } from "@/lib/contact-channel";
import { validateRedirectUrl } from "@/lib/redirect-urls";
import { Tenancy, getTenancy } from "@/lib/tenancies";
import { oauthCookieSchema } from "@/lib/tokens";
import { getProvider, oauthServer } from "@/oauth";
import { prismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { InvalidClientError, InvalidScopeError, Request as OAuthRequest, Response as OAuthResponse } from "@node-oauth/oauth2-server";
import { KnownError, KnownErrors } from "@stackframe/stack-shared";
import { yupMixed, yupNumber, yupObject, yupString } from "@stackframe/stack-shared/dist/schema-fields";
import { StackAssertionError, StatusError, captureError } from "@stackframe/stack-shared/dist/utils/errors";
import { deindent, extractScopes } from "@stackframe/stack-shared/dist/utils/strings";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { oauthResponseToSmartResponse } from "../../oauth-helpers";

const redirectOrThrowError = (error: KnownError, tenancy: Tenancy, errorRedirectUrl?: string) => {
  if (!errorRedirectUrl || !validateRedirectUrl(errorRedirectUrl, tenancy.config.domains, tenancy.config.allow_localhost)) {
    throw error;
  }

  const url = new URL(errorRedirectUrl);
  url.searchParams.set("errorCode", error.errorCode);
  url.searchParams.set("message", error.message);
  url.searchParams.set("details", error.details ? JSON.stringify(error.details) : JSON.stringify({}));
  redirect(url.toString());
};

const handler = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    params: yupObject({
      provider_id: yupString().defined(),
    }).defined(),
    query: yupMixed().optional(),
    body: yupMixed().optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([307]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
    headers: yupMixed().defined(),
  }),
  async handler({ params, query, body }, fullReq) {
    const innerState = query.state ?? (body as any)?.state ?? "";
    const cookieInfo = (await cookies()).get("stack-oauth-inner-" + innerState);
    (await cookies()).delete("stack-oauth-inner-" + innerState);

    if (cookieInfo?.value !== 'true') {
      throw new StatusError(StatusError.BadRequest, "Inner OAuth cookie not found. This is likely because you refreshed the page during the OAuth sign in process. Please try signing in again");
    }

    const outerInfoDB = await prismaClient.oAuthOuterInfo.findUnique({
      where: {
        innerState: innerState,
      },
    });

    if (!outerInfoDB) {
      throw new StatusError(StatusError.BadRequest, "Invalid OAuth cookie. Please try signing in again.");
    }

    let outerInfo: Awaited<ReturnType<typeof oauthCookieSchema.validate>>;
    try {
      outerInfo = await oauthCookieSchema.validate(outerInfoDB.info);
    } catch (error) {
      throw new StackAssertionError("Invalid outer info");
    }

    const {
      tenancyId,
      innerCodeVerifier,
      type,
      projectUserId,
      providerScope,
      errorRedirectUrl,
      afterCallbackRedirectUrl,
    } = outerInfo;

    const tenancy = await getTenancy(tenancyId);
    if (!tenancy) {
      throw new StackAssertionError("Tenancy in outerInfo not found; has it been deleted?", { tenancyId });
    }

    try {
      if (outerInfoDB.expiresAt < new Date()) {
        throw new KnownErrors.OuterOAuthTimeout();
      }

      const provider = tenancy.config.oauth_providers.find((p) => p.id === params.provider_id);
      if (!provider || !provider.enabled) {
        throw new KnownErrors.OAuthProviderNotFoundOrNotEnabled();
      }

      const providerObj = await getProvider(provider);
      let callbackResult: Awaited<ReturnType<typeof providerObj.getCallback>>;
      try {
        callbackResult = await providerObj.getCallback({
          codeVerifier: innerCodeVerifier,
          state: innerState,
          callbackParams: {
            ...query,
            ...body,
          },
        });
      } catch (error) {
        if (error instanceof KnownErrors['OAuthProviderAccessDenied']) {
          redirectOrThrowError(error, tenancy, errorRedirectUrl);
        }
        throw error;
      }

      const { userInfo, tokenSet } = callbackResult;

      if (type === "link") {
        if (!projectUserId) {
          throw new StackAssertionError("projectUserId not found in cookie when authorizing signed in user");
        }

        const user = await prismaClient.projectUser.findUnique({
          where: {
            tenancyId_projectUserId: {
              tenancyId,
              projectUserId,
            },
          },
          include: {
            projectUserOAuthAccounts: {
              include: {
                providerConfig: true,
              }
            }
          }
        });
        if (!user) {
          throw new StackAssertionError("User not found");
        }

        const account = user.projectUserOAuthAccounts.find((a) => a.providerConfig.id === provider.id);
        if (account && account.providerAccountId !== userInfo.accountId) {
          throw new KnownErrors.UserAlreadyConnectedToAnotherOAuthConnection();
        }
      }

      const oauthRequest = new OAuthRequest({
        headers: {},
        body: {},
        method: "GET",
        query: {
          client_id: tenancy.project.id,
          client_secret: outerInfo.publishableClientKey,
          redirect_uri: outerInfo.redirectUri,
          state: outerInfo.state,
          scope: outerInfo.scope,
          grant_type: outerInfo.grantType,
          code_challenge: outerInfo.codeChallenge,
          code_challenge_method: outerInfo.codeChallengeMethod,
          response_type: outerInfo.responseType,
        }
      });

      const storeTokens = async () => {
        if (tokenSet.refreshToken) {
          await prismaClient.oAuthToken.create({
            data: {
              tenancyId: outerInfo.tenancyId,
              oAuthProviderConfigId: provider.id,
              refreshToken: tokenSet.refreshToken,
              providerAccountId: userInfo.accountId,
              scopes: extractScopes(providerObj.scope + " " + providerScope),
            }
          });
        }

        await prismaClient.oAuthAccessToken.create({
          data: {
            tenancyId: outerInfo.tenancyId,
            oAuthProviderConfigId: provider.id,
            accessToken: tokenSet.accessToken,
            providerAccountId: userInfo.accountId,
            scopes: extractScopes(providerObj.scope + " " + providerScope),
            expiresAt: tokenSet.accessTokenExpiredAt,
          }
        });
      };

      const oauthResponse = new OAuthResponse();
      try {
        await oauthServer.authorize(
          oauthRequest,
          oauthResponse,
          {
            authenticateHandler: {
              handle: async () => {
                const oldAccount = await prismaClient.projectUserOAuthAccount.findUnique({
                  where: {
                    tenancyId_oauthProviderConfigId_providerAccountId: {
                      tenancyId: outerInfo.tenancyId,
                      oauthProviderConfigId: provider.id,
                      providerAccountId: userInfo.accountId,
                    },
                  },
                });

                // ========================== link account with user ==========================
                if (type === "link") {
                  if (!projectUserId) {
                    throw new StackAssertionError("projectUserId not found in cookie when authorizing signed in user");
                  }

                  if (oldAccount) {
                    // ========================== account already connected ==========================
                    if (oldAccount.projectUserId !== projectUserId) {
                      throw new KnownErrors.OAuthConnectionAlreadyConnectedToAnotherUser();
                    }
                    await storeTokens();
                  } else {
                    // ========================== connect account with user ==========================
                    await prismaClient.projectUserOAuthAccount.create({
                      data: {
                        providerAccountId: userInfo.accountId,
                        email: userInfo.email,
                        providerConfig: {
                          connect: {
                            projectConfigId_id: {
                              projectConfigId: tenancy.config.id,
                              id: provider.id,
                            },
                          },
                        },
                        projectUser: {
                          connect: {
                            tenancyId_projectUserId: {
                              tenancyId: outerInfo.tenancyId,
                              projectUserId: projectUserId,
                            },
                          },
                        },
                      },
                    });
                  }

                  await storeTokens();
                  return {
                    id: projectUserId,
                    newUser: false,
                    afterCallbackRedirectUrl,
                  };
                } else {

                  // ========================== sign in user ==========================

                  if (oldAccount) {
                    await storeTokens();

                    return {
                      id: oldAccount.projectUserId,
                      newUser: false,
                      afterCallbackRedirectUrl,
                    };
                  }

                  // ========================== sign up user ==========================

                  if (!tenancy.config.sign_up_enabled) {
                    throw new KnownErrors.SignUpNotEnabled();
                  }

                  let primaryEmailAuthEnabled = false;
                  if (userInfo.email) {
                    primaryEmailAuthEnabled = true;

                    const oldContactChannel = await getAuthContactChannel(
                      prismaClient,
                      {
                        tenancyId: outerInfo.tenancyId,
                        type: 'EMAIL',
                        value: userInfo.email,
                      }
                    );
                    if (oldContactChannel && oldContactChannel.usedForAuth) {
                      // if the email is already used for auth by another account, still create an account but don't
                      // enable auth on it
                      primaryEmailAuthEnabled = false;
                    }
                    // TODO: check whether this OAuth account can be used to login to an existing non-OAuth account instead
                  }

                  const newAccount = await usersCrudHandlers.adminCreate({
                    tenancy,
                    data: {
                      display_name: userInfo.displayName,
                      profile_image_url: userInfo.profileImageUrl || undefined,
                      primary_email: userInfo.email,
                      primary_email_verified: userInfo.emailVerified,
                      primary_email_auth_enabled: primaryEmailAuthEnabled,
                      oauth_providers: [{
                        id: provider.id,
                        account_id: userInfo.accountId,
                        email: userInfo.email,
                      }],
                    },
                  });

                  await storeTokens();
                  return {
                    id: newAccount.id,
                    newUser: true,
                    afterCallbackRedirectUrl,
                  };
                }
              }
            }
          }
        );
      } catch (error) {
        if (error instanceof InvalidClientError) {
          if (error.message.includes("redirect_uri") || error.message.includes("redirectUri")) {
            throw new KnownErrors.RedirectUrlNotWhitelisted();
          }
        } else if (error instanceof InvalidScopeError) {
          // which scopes are being requested, and by whom?
          // I think this is a bug in the client? But just to be safe, let's log an error to make sure that it is not our fault
          // TODO: remove the captureError once you see in production that our own clients never trigger this
          captureError("outer-oauth-callback-invalid-scope", new StackAssertionError(deindent`
            A client requested an invalid scope. Is this a bug in the client, or our fault?

              Scopes requested: ${oauthRequest.query?.scope}
          `, { outerInfo, cause: error, scopes: oauthRequest.query?.scope }));
          throw new StatusError(400, "Invalid scope requested. Please check the scopes you are requesting.");
        }
        throw error;
      }

      return oauthResponseToSmartResponse(oauthResponse);
    } catch (error) {
      if (error instanceof KnownError) {
        redirectOrThrowError(error, tenancy, errorRedirectUrl);
      }
      throw error;
    }
  },
});

export const GET = handler;
export const POST = handler;
