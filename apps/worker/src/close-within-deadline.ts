export const WORKER_CLOSE_DEADLINE_MS = 5_000;

export async function closeWithinDeadline(operation: Promise<unknown>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), WORKER_CLOSE_DEADLINE_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
