-- Aynı soru + sipariş kalemi için birden fazla AKTİF talep açılmasını engeller.
-- Aktif = PENDING_REVIEW veya NEEDS_VERIFICATION.
-- Onaylanmış/reddedilmiş/geçersiz talepler geçmiş olarak kalır ve tekrarı engellemez.

CREATE UNIQUE INDEX IF NOT EXISTS order_change_requests_active_unique
  ON order_change_requests ("questionId", "orderNumber", COALESCE("lineId", ''))
  WHERE status IN ('PENDING_REVIEW', 'NEEDS_VERIFICATION');
