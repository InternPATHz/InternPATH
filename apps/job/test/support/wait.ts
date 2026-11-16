/** Poll observed state rather than sleeping for an assumed delivery/transaction duration. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the expected test state');
}
