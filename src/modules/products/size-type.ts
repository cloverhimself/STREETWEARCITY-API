import type { SizeType } from "@prisma/client";

// Mirrors streetwarecity/src/lib/data.ts's sizesFor() — the size list a given
// sizeType maps to is a fixed, shared piece of domain knowledge, not admin input.
export function sizesFor(sizeType: SizeType): string[] {
  switch (sizeType) {
    case "CLOTHING":
      return ["XS", "S", "M", "L", "XL", "XXL"];
    case "ADJUSTABLE":
      return ["One Size (Adjustable)"];
    case "FITTED":
      return ["7", "7 1/8", "7 1/4", "7 3/8", "7 1/2", "7 5/8"];
    case "WAIST":
      return ["28", "30", "32", "34", "36", "38"];
  }
}

// Frontend sizeType strings are lowercase ("clothing"), the Prisma enum is
// uppercase ("CLOTHING") — this is the one place that boundary gets crossed.
export function toDbSizeType(sizeType: string): SizeType {
  return sizeType.toUpperCase() as SizeType;
}

export function fromDbSizeType(sizeType: SizeType): string {
  return sizeType.toLowerCase();
}
