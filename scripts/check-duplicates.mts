import "dotenv/config";
import { getPrisma } from "../src/lib/prisma.ts";

const prisma = getPrisma();

const rows = await prisma.$queryRaw<
  Array<{ storeId: string; productMainId: string; adet: bigint }>
>`
  SELECT "storeId", "productMainId", COUNT(*)::bigint AS adet
  FROM product_infos
  WHERE "productId" IS NULL
  GROUP BY 1, 2
  HAVING COUNT(*) > 1
`;

const total = await prisma.productInfo.count();
const mainCards = await prisma.productInfo.count({ where: { productId: null } });

console.log(`toplam kart: ${total}`);
console.log(`ana ürün kartı (productId IS NULL): ${mainCards}`);
console.log(`mükerrer ana ürün grubu: ${rows.length}`);
for (const row of rows) console.log(` - store=${row.storeId} main=${row.productMainId} adet=${row.adet}`);
await prisma.$disconnect();
process.exit(rows.length > 0 ? 3 : 0);
