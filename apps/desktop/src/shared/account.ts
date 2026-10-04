export const ACCOUNT_IPC = {
  state: "deckastra:account:state",
  signIn: "deckastra:account:sign-in",
  signOut: "deckastra:account:sign-out",
} as const;

export interface AccountState {
  signedIn: boolean;
  email: string | null;
  configured: boolean;
}

export interface AccountBridge {
  state(): Promise<AccountState>;
  signIn(): Promise<AccountState>;
  signOut(): Promise<AccountState>;
}
