import { CognitoJwtVerifier } from 'aws-jwt-verify'
import type { JwksCache } from 'aws-jwt-verify/jwk'
import { AuditError, cognitoIdentity, cognitoSubSchema, TOKEN_HEADER } from '@repo-sentinel/core'

export function cognitoConfig(env = process.env) {
  if (env.LOCAL_AUTH_BYPASS === 'true' || (env.AUTH_MODE !== undefined && env.AUTH_MODE !== 'cognito') ||
    (env.COGNITO_TOKEN_USE !== undefined && env.COGNITO_TOKEN_USE !== 'access') ||
    (env.JWT_HEADER !== undefined && env.JWT_HEADER.toLowerCase() !== TOKEN_HEADER.toLowerCase())) {
    throw new Error('Cognito access-token authentication is required.')
  }
  return { ...cognitoIdentity(env.COGNITO_ISSUER, env.COGNITO_CLIENT_ID), allowedUserSub: cognitoSubSchema.parse(env.ALLOWED_USER_SUB) }
}

export function createCognitoAuthorizer(config: ReturnType<typeof cognitoConfig>, jwksCache?: JwksCache) {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId, tokenUse: 'access', clientId: config.clientId,
  }, jwksCache ? { jwksCache } : undefined)
  return async (request: Request): Promise<string | undefined> => {
    const token = request.headers.get(TOKEN_HEADER)
    if (!token || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return undefined
    let payload
    try {
      payload = await verifier.verify(token)
      if (!Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000 || !cognitoSubSchema.safeParse(payload.sub).success) return undefined
    } catch {
      // Signature, claim, key lookup and transport failures all deny access.
      // Do not log the JWT, decoded claims, or the verifier's raw error.
      return undefined
    }
    if (payload.sub !== config.allowedUserSub) throw new AuditError('FORBIDDEN', 'このユーザーには利用権限がありません。', 403)
    return payload.sub
  }
}
