type MoneyInput = number | string | { toString(): string };

export function toMinorUnits(value: MoneyInput): number {
  const normalized = value.toString().trim();
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`Invalid money value: ${normalized}`);
  const [, sign, whole, fraction = ""] = match;
  const thirdDigit = Number(fraction[2] ?? "0");
  const padded = `${fraction}00`;
  let minor = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (thirdDigit >= 5) minor += 1;
  const signed = sign === "-" ? -minor : minor;
  if (!Number.isSafeInteger(signed)) throw new Error(`Money value exceeds safe integer range: ${normalized}`);
  return signed;
}

export function fromMinorUnits(minor: number): number {
  if (!Number.isSafeInteger(minor)) throw new Error(`Minor-unit value must be a safe integer: ${minor}`);
  return minor / 100;
}

export function minorUnitsToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error(`Minor-unit value must be a safe integer: ${minor}`);
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function moneyMatches(expected: MoneyInput, received: MoneyInput): boolean {
  return toMinorUnits(expected) === toMinorUnits(received);
}
