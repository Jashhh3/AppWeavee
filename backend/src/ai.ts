export interface AIProvider {
  readonly name: string;
  generate(prompt: string): Promise<{ output: string; configured: boolean }>;
  test(): Promise<{ reachable: boolean; message: string }>;
}

/** Safe default: it never sends prompts over the network or reads credentials. */
export class SafeStubProvider implements AIProvider {
  readonly name = 'safe-stub';
  async generate(_prompt: string) { return { output: 'AI provider is not configured. No external request was made.', configured: false }; }
  async test() { return { reachable: false, message: 'Safe test completed without making an external request.' }; }
}
