import { z } from 'zod'

export const TOKEN_HEADER = 'X-Access-Token'
export const cognitoSubSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

export function cognitoIdentity(issuer: string | undefined, clientId: string | undefined) {
  const match = issuer?.match(/^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9-]+_[A-Za-z0-9]+)$/)
  if (!match || !match[2].startsWith(`${match[1]}_`) || !clientId || !/^[A-Za-z0-9]{1,128}$/.test(clientId)) {
    throw new Error('Valid COGNITO_ISSUER and COGNITO_CLIENT_ID are required.')
  }
  return { issuer: issuer!, clientId, region: match[1], userPoolId: match[2] }
}

export function cognitoLoginOrigin(value: string | undefined, region: string) {
  const url = new URL(value ?? '')
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
    !new RegExp(`^[a-z0-9][a-z0-9-]*\\.auth\\.${region}\\.amazoncognito\\.com$`).test(url.hostname)) {
    throw new Error('COGNITO_LOGIN_URL must be the HTTPS managed login origin.')
  }
  return url.origin
}
