-- Sahiplik doğrulaması ayrı bir denetim olayı olarak izlenir.
ALTER TYPE "OrderChangeAction" ADD VALUE IF NOT EXISTS 'OWNERSHIP_VERIFIED';
