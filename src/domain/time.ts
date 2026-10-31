export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
