export interface AIProvider {
  readonly name: string;
  generate(prompt: string): Promise<{ output: string; configured: boolean }>;
}

/** Safe default: it never sends prompts over the network or reads credentials. */
export class SafeStubProvider implements AIProvider {
  readonly name = 'safe-stub';
  async generate(_prompt: string) { return { output: 'AI provider is not configured. No external request was made.', configured: false }; }
}
