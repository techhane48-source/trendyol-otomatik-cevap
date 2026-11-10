-- lineId harici (Trendyol) kimliktir; yerel OrderLine ilişkisi kaldırılır.
ALTER TABLE "order_change_requests" DROP CONSTRAINT IF EXISTS "order_change_requests_lineId_fkey";
