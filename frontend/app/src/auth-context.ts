import { createContext, useContext } from 'react'

export const AuthContext = createContext<{ mode: 'cognito' | 'local-bypass'; logout: () => Promise<void> } | undefined>(undefined)
export function useAuth() {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('Authentication context is required.')
  return auth
}
