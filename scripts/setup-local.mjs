import { chmod, readFile, writeFile } from 'node:fs/promises'

const version = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim()
if (process.versions.node !== version) throw new Error(`Run fnm use ${version} first (current: ${process.versions.node}).`)
let contents = await readFile('.env', 'utf8').catch((error) => {
  if (error.code !== 'ENOENT') throw error
  return ''
})
for (const [key, value] of Object.entries({ NODE_VERSION: version, LOCAL_UID: process.getuid(), LOCAL_GID: process.getgid() })) {
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  contents = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`
}
await writeFile('.env', contents.trimStart(), { mode: 0o600 })
await chmod('.env', 0o600)
console.log('Updated local Node version and UID/GID in .env.')
