-- GÖREV 015: cevap kalitesi durumları (ANSWERED / PARTIAL / HUMAN_REVIEW)
-- Eski değerler (RESOLVED, GENERIC) geriye dönük uyumluluk için korunur.
ALTER TYPE "DraftResolution" ADD VALUE IF NOT EXISTS 'ANSWERED';
ALTER TYPE "DraftResolution" ADD VALUE IF NOT EXISTS 'PARTIAL';
ALTER TYPE "DraftResolution" ADD VALUE IF NOT EXISTS 'HUMAN_REVIEW';
