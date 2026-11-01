import { describe, expect, it } from 'vitest'
import { CommandError, prepareDevUser } from '../../scripts/create-dev-user.js'

const poolId = 'ap-northeast-1_TestPool'
const sub = '11111111-2222-4333-8444-555555555555'
const email = 'owner@example.com'
const user = { UserStatus: 'CONFIRMED', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'], UserAttributes: [
  { Name: 'sub', Value: sub }, { Name: 'email', Value: email },
] }

function fixture(options: { account?: string; poolName?: string; existing?: boolean; anotherUser?: boolean; lookupFailure?: string; race?: boolean } = {}) {
  const calls: { program: string; args: string[] }[] = []
  let raced = false
  const run = async (program: 'aws' | 'terraform', args: string[]) => {
    calls.push({ program, args })
    if (program === 'terraform') return poolId
    switch (args[1]) {
      case 'get-caller-identity': return JSON.stringify({ Account: options.account ?? '103492189525' })
      case 'describe-user-pool': return JSON.stringify({ Id: poolId, Name: options.poolName ?? 'repo-sentinel-dev',
        Arn: `arn:aws:cognito-idp:ap-northeast-1:103492189525:userpool/${poolId}`,
        MfaConfiguration: 'ON', AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } })
      case 'get-user-pool-mfa-config': return JSON.stringify({ SoftwareTokenMfaConfiguration: { Enabled: true } })
      case 'admin-get-user':
        if (options.lookupFailure) throw new CommandError(options.lookupFailure)
        if (options.existing || raced) return JSON.stringify(user)
        throw new CommandError('UserNotFoundException')
      case 'list-users': return JSON.stringify(options.anotherUser ? ['another-user'] : [])
      case 'admin-create-user':
        if (options.race) { raced = true; throw new CommandError('UsernameExistsException') }
        return JSON.stringify({ User: { UserStatus: 'FORCE_CHANGE_PASSWORD', Attributes: user.UserAttributes } })
      default: throw new Error(`Unexpected test operation: ${args[1]}`)
    }
  }
  return { calls, run, writes: () => calls.filter(({ args }) => args[1] === 'admin-create-user') }
}

describe('dev Cognito user bootstrap', () => {
  it('defaults to a read-only preview without sending an invitation', async () => {
    const f = fixture()
    expect(await prepareDevUser({ email }, f.run)).toMatchObject({ action: 'would_create', poolId, sub: null })
    expect(f.writes()).toHaveLength(0)
  })
  it('creates once using an AWS-generated emailed password, without auto-verifying email', async () => {
    const f = fixture()
    expect(await prepareDevUser({ email, create: true }, f.run)).toMatchObject({ action: 'created', sub, status: 'FORCE_CHANGE_PASSWORD', mfaConfigured: false })
    expect(f.writes()).toHaveLength(1)
    const args = f.writes()[0].args
    expect(JSON.parse(args[args.indexOf('--user-attributes') + 1])).toEqual([{ Name: 'email', Value: email }])
    expect(args[args.indexOf('--desired-delivery-mediums') + 1]).toBe('EMAIL')
    expect(args).not.toContain('--temporary-password')
    expect(args).not.toContain('--message-action')
    expect(args).not.toContain('--force-alias-creation')
  })
  it('preserves an existing confirmed user, password, and MFA without resending mail', async () => {
    const f = fixture({ existing: true })
    expect(await prepareDevUser({ email, create: true }, f.run)).toMatchObject({ action: 'exists', sub, status: 'CONFIRMED', mfaConfigured: true })
    expect(f.writes()).toHaveLength(0)
    expect(f.calls.filter(({ program }) => program === 'aws').map(({ args }) => args[1])).toEqual([
      'get-caller-identity', 'describe-user-pool', 'get-user-pool-mfa-config', 'admin-get-user',
    ])
  })
  it('does not mistake an authorization failure for a missing user', async () => {
    const f = fixture({ lookupFailure: 'AccessDeniedException' })
    await expect(prepareDevUser({ email, create: true }, f.run)).rejects.toMatchObject({ code: 'AccessDeniedException' })
    expect(f.writes()).toHaveLength(0)
  })
  it('refuses to add another user to a nonempty pool', async () => {
    const f = fixture({ anotherUser: true })
    await expect(prepareDevUser({ email, create: true }, f.run)).rejects.toThrow('another user')
    expect(f.writes()).toHaveLength(0)
  })
  it.each([{ account: '000000000000' }, { poolName: 'repo-sentinel-prod' }])('refuses the wrong target %j', async (options) => {
    const f = fixture(options)
    await expect(prepareDevUser({ email, create: true }, f.run)).rejects.toThrow('Unexpected')
    expect(f.writes()).toHaveLength(0)
  })
  it('handles a concurrent same-user creation without creating again', async () => {
    const f = fixture({ race: true })
    expect(await prepareDevUser({ email, create: true }, f.run)).toMatchObject({ action: 'exists', sub })
    expect(f.writes()).toHaveLength(1)
  })
  it('rejects invalid email before contacting any service', async () => {
    const f = fixture()
    await expect(prepareDevUser({ email: 'not-an-email', create: true }, f.run)).rejects.toThrow('valid email')
    expect(f.calls).toHaveLength(0)
  })
})
