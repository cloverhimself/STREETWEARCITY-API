import { findVariant } from "../products/products.service";

export interface CartLineInput {
  productId: string;
  color: string;
  size: string;
  qty: number;
}

export type CartLineIssue = "not_found" | "insufficient_stock" | null;

export interface ValidatedCartLine extends CartLineInput {
  variantId: string | null;
  productName: string;
  unitPrice: number;
  availableStock: number;
  issue: CartLineIssue;
}

// The one place cart lines get resolved against real variants/inventory —
// both the /cart/validate pre-check and order creation call this, so a
// price or stock number can never disagree between the two.
export async function resolveCartLines(lines: CartLineInput[]): Promise<ValidatedCartLine[]> {
  return Promise.all(
    lines.map(async (line): Promise<ValidatedCartLine> => {
      const variant = await findVariant(line.productId, line.color, line.size);
      if (!variant) {
        return { ...line, variantId: null, productName: "", unitPrice: 0, availableStock: 0, issue: "not_found" };
      }
      const availableStock = variant.inventory ? variant.inventory.totalQuantity - variant.inventory.reservedQuantity : 0;
      return {
        ...line,
        variantId: variant.id,
        productName: variant.product.name,
        unitPrice: Number(variant.product.price),
        availableStock,
        issue: availableStock < line.qty ? "insufficient_stock" : null,
      };
    })
  );
}
