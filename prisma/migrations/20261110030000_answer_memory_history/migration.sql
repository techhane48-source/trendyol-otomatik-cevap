-- Geçmiş cevap hafızası: cevap doğrulama durumu, taslakta kullanılan geçmiş kayıtları
-- ve sipariş sahipliği doğrulamasının ayrı izlenmesi.

CREATE TYPE "AnswerReviewStatus" AS ENUM ('UNREVIEWED', 'VERIFIED', 'WRONG', 'OUTDATED');

ALTER TABLE "questions"
  ADD COLUMN "answerReviewStatus" "AnswerReviewStatus" NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN "answerReviewNote" TEXT,
  ADD COLUMN "answerReviewedBy" TEXT,
  ADD COLUMN "answerReviewedAt" TIMESTAMP(3);

CREATE INDEX "questions_storeId_answerReviewStatus_idx" ON "questions"("storeId", "answerReviewStatus");

ALTER TABLE "answer_drafts" ADD COLUMN "historyUsed" JSONB;

ALTER TABLE "order_change_requests"
  ADD COLUMN "ownershipVerifiedBy" TEXT,
  ADD COLUMN "ownershipVerifiedAt" TIMESTAMP(3);
