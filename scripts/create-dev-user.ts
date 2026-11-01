import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const execute = promisify(execFile)
const accountId = '103492189525'
const region = 'ap-northeast-1'
const poolName = 'repo-sentinel-dev'
const terraformDirectory = fileURLToPath(new URL('../infra/terraform/environments/dev/', import.meta.url))

type Runner = (program: 'aws' | 'terraform', args: string[]) => Promise<string>
type Attribute = { Name: string; Value: string }
type User = {
  UserAttributes?: Attribute[]
  Attributes?: Attribute[]
  UserStatus?: string
  UserMFASettingList?: string[]
}
type Pool = {
  Id: string
  Name: string
  Arn: string
  MfaConfiguration: string
  AdminCreateUserConfig: { AllowAdminCreateUserOnly: boolean }
}

export class CommandError extends Error {
  constructor(readonly code: string, program: string = 'aws') {
    super(`${program} failed (${code}). Check your CLI session and permissions; no automatic retry was performed.`)
  }
}

const runCommand: Runner = async (program, args) => {
  try {
    const { stdout } = await execute(program, args, {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_MAX_ATTEMPTS: '1' },
    })
    return stdout
  } catch (error) {
    // Never echo CLI stderr, request data, or a raw error containing arguments.
    const failure = error as { stderr?: string; code?: string }
    const code = /An error occurred \(([A-Za-z0-9]+)\)/.exec(failure.stderr ?? '')?.[1]
    throw new CommandError(code ?? (failure.code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : 'CLI_ERROR'), program)
  }
}

export async function prepareDevUser(
  options: { email: string; create?: boolean; profile?: string },
  run: Runner = runCommand,
) {
  const email = options.email.trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Provide a valid email address with --email.')
  }
  const profile = options.profile ?? 'kupacllc'
  const aws = async <T>(service: string, operation: string, ...args: string[]): Promise<T> =>
    JSON.parse(await run('aws', [service, operation, ...args,
      '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager'])) as T

  const identity = await aws<{ Account: string }>('sts', 'get-caller-identity')
  if (identity.Account !== accountId) throw new Error('Unexpected AWS account; this script manages Repo Sentinel dev only.')
  const poolId = (await run('terraform', [`-chdir=${terraformDirectory}`, 'output', '-raw', 'cognito_user_pool_id'])).trim()
  if (!/^ap-northeast-1_[A-Za-z0-9]+$/.test(poolId)) throw new Error('Invalid dev User Pool output; check the foundation apply.')
  const pool = await aws<Pool>('cognito-idp', 'describe-user-pool', '--user-pool-id', poolId, '--query', 'UserPool')
  if (pool.Id !== poolId || pool.Name !== poolName ||
    pool.Arn !== `arn:aws:cognito-idp:${region}:${accountId}:userpool/${poolId}` ||
    pool.AdminCreateUserConfig.AllowAdminCreateUserOnly !== true || pool.MfaConfiguration !== 'ON') {
    throw new Error('Unexpected dev User Pool or authentication settings; no user was changed.')
  }
  const mfa = await aws<{ SoftwareTokenMfaConfiguration?: { Enabled: boolean } }>(
    'cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', poolId,
  )
  if (!mfa.SoftwareTokenMfaConfiguration?.Enabled) throw new Error('TOTP must be enabled before preparing the dev user.')

  const findUser = async () => {
    try {
      return await aws<User>('cognito-idp', 'admin-get-user', '--user-pool-id', poolId, '--username', email)
    } catch (error) {
      if (error instanceof CommandError && error.code === 'UserNotFoundException') return null
      throw error
    }
  }
  const result = (action: 'exists' | 'created', user: User) => {
    const attributes = user.UserAttributes ?? user.Attributes ?? []
    const sub = attributes.find((attribute) => attribute.Name === 'sub')?.Value
    const storedEmail = attributes.find((attribute) => attribute.Name === 'email')?.Value
    if (!sub || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sub) || storedEmail?.toLowerCase() !== email.toLowerCase()) {
      throw new Error('Unexpected user attributes; inspect the dev User Pool before continuing.')
    }
    return { action, accountId, poolId, sub, status: user.UserStatus, mfaConfigured: user.UserMFASettingList?.includes('SOFTWARE_TOKEN_MFA') ?? false }
  }

  const existing = await findUser()
  if (existing) return result('exists', existing)
  const users = await aws<string[]>('cognito-idp', 'list-users', '--user-pool-id', poolId, '--max-items', '2', '--query', 'Users[].Username')
  if (users.length) throw new Error('The dev pool already contains another user; this bootstrap will not add a second user.')
  if (!options.create) return { action: 'would_create', accountId, poolId, sub: null }

  try {
    const response = await aws<{ User: User }>('cognito-idp', 'admin-create-user',
      '--user-pool-id', poolId, '--username', email,
      '--user-attributes', JSON.stringify([{ Name: 'email', Value: email }]),
      '--desired-delivery-mediums', 'EMAIL',
    )
    // Omit TemporaryPassword: Cognito generates and emails it. No password or
    // TOTP secret is accepted, printed, saved to a file, or passed to Terraform.
    return result('created', response.User)
  } catch (error) {
    if (error instanceof CommandError && error.code === 'UsernameExistsException') {
      const racedUser = await findUser()
      if (racedUser) return result('exists', racedUser)
    }
    throw error
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    email: { type: 'string' }, profile: { type: 'string', default: 'kupacllc' },
    create: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } })
  if (values.help) {
    console.log('Usage: npm run cognito:user -- --email <your-email> [--profile kupacllc] [--create]\nDefault: read-only check. --create creates a missing dev user and sends one invitation email.\nExisting users are only read; passwords, MFA, and invitations are never reset or resent.')
    return
  }
  if (!values.email) throw new Error('--email is required. Use --help for usage.')
  console.log(JSON.stringify(await prepareDevUser({ email: values.email, profile: values.profile, create: values.create }), null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => { console.error(error.message); process.exitCode = 1 })
}
