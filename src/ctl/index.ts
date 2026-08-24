export { Client, ClientError } from './client.js'
export { loadClientConfig, defaultClientConfigPath, clientConfigSchema } from './config.js'
export type { ClientConfig } from './config.js'
export { diffAgainstHead, stagedDivergence, repoRoot, gitDir, git, GitError } from './git.js'
export { fingerprint } from './diff.js'

export const VERSION = '0.0.0'
