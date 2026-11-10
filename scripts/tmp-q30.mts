import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
const prisma = getPrisma();
const rows = await prisma.question.findMany({ where: { answerText: { not: null } }, orderBy: { askedAt: "desc" }, take: 30, select: { id: true, text: true, productName: true } });
rows.forEach((r, i) => console.log(`${i + 1}. ${r.text.replace(/\s+/g, " ").slice(0, 150)}`));
await prisma.$disconnect();
