import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { AuditError } from '@repo-sentinel/core'

export function createOpenaiKeyProvider(client: Pick<SecretsManagerClient, 'send'>, secretArn: string) {
  let value: Promise<string> | undefined
  let expires = 0
  return async () => {
    if (!value || Date.now() >= expires) {
      expires = Date.now() + 300_000
      value = (async () => {
        try {
          const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }))
          const key = result.SecretString?.trim()
          if (!key || key.length > 512 || !/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error('Invalid secret')
          return key
        } catch {
          value = undefined
          throw new AuditError('AI_NOT_CONFIGURED', 'AIの認証情報を取得できません。', 503)
        }
      })()
    }
    return value
  }
}
