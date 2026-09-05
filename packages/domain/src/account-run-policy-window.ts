export type AccountRunBackgroundWindow = { start: string; end: string };

export function shanghaiTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return `${parts.find((part) => part.type === "hour")!.value}:${parts.find((part) => part.type === "minute")!.value}`;
}

export function isInBackgroundWindow(time: string, window: AccountRunBackgroundWindow): boolean {
  return window.start < window.end ? time >= window.start && time < window.end : time >= window.start || time < window.end;
}

export function isDateInBackgroundWindow(date: Date, window: AccountRunBackgroundWindow): boolean {
  return isInBackgroundWindow(shanghaiTime(date), window);
}
