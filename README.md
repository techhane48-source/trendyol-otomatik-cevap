# Trendyol Soru Asistanı — Faz 1

Trendyol satıcılarının müşteri sorularını **salt okunur** olarak çeken, veritabanına kaydeden ve
listeleyen SaaS temeli.

> **Kapsam sınırı:** Bu sürüm Trendyol'a **hiçbir yazma işlemi** yapmaz. Cevap gönderme, ürün
> güncelleme, sipariş değiştirme gibi endpoint'ler kod içinde bulunmaz. Tek kullanılan endpoint:
> `GET /integration/qna/sellers/{sellerId}/questions/filter`.

## Teknolojiler

| Katman | Teknoloji |
| --- | --- |
| Uygulama | Next.js 16 (App Router), TypeScript, React 19 |
| Veritabanı | PostgreSQL + Prisma 7 (`@prisma/adapter-pg`) |
| Doğrulama | Zod 4 (ortam değişkenleri + API yanıtları) |
| Test | Vitest 5 (gömülü PostgreSQL ile gerçek veritabanı testleri) |

## Veri modeli

- **Store** — Trendyol satıcısı (`sellerId` benzersiz).
- **Question** — müşteri sorusu. Kimlik `@@unique([storeId, trendyolQuestionId])` ile mağaza
  bazında benzersizdir; aynı soru tekrar çekildiğinde **upsert** ile güncellenir, kopya oluşmaz.
- **SyncRun** — her senkronizasyon denemesinin kaydı: durum (`RUNNING/SUCCESS/PARTIAL/FAILED`),
  başlangıç/bitiş, süre, çekilen/kaydedilen kayıt ve sayfa sayısı, hata kodu.

Tablolar `prisma/migrations/` altındaki migration ile oluşturulur.

## Kurulum

```bash
npm install                 # bağımlılıklar + prisma generate (postinstall)
cp .env.example .env        # değerleri doldurun
```

### 1. Veritabanı

İki seçenek var.

**A) Gömülü PostgreSQL (önerilen, Docker/kurulum gerekmez)**

```bash
npm run pg:dev
# Çıktıdaki DATABASE_URL değerini .env içine yazın:
# postgresql://postgres:postgres@127.0.0.1:55432/trendyol_dev?schema=public
```

**B) Mevcut PostgreSQL sunucusu** — `.env` içindeki `DATABASE_URL` değerini kendi sunucunuza
yönlendirin.

### 2. Migration

```bash
npm run db:migrate      # geliştirme: migration oluşturur/uygular
# veya
npm run db:deploy       # var olan migration'ları uygular (CI/prod)
```

### 3. Ortam değişkenleri

`.env.example` dosyasını kopyalayıp doldurun. Doğrulama Zod ile yapılır; eksik ya da hatalı değer
varsa uygulama **alan adı ile** birlikte hata verir, hiçbir gizli değer ekrana/loga yazılmaz.

| Değişken | Zorunlu | Açıklama |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL bağlantı adresi |
| `TRENDYOL_SELLER_ID` | ✅ | Satıcı kimliği (sadece rakam) |
| `TRENDYOL_API_KEY` | ✅ | Trendyol API anahtarı |
| `TRENDYOL_API_SECRET` | ✅ | Trendyol API gizli anahtarı |
| `TRENDYOL_BASE_URL` | — | Varsayılan `https://apigw.trendyol.com/integration/qna` |
| `TRENDYOL_USER_AGENT` | — | Varsayılan `{sellerId} - SelfIntegration` |
| `SYNC_PAGE_SIZE` | — | Varsayılan `50` |
| `SYNC_MAX_PAGES` | — | Varsayılan `100` |
| `SYNC_MAX_RETRIES` | — | Varsayılan `3` |
| `SYNC_RETRY_BASE_MS` | — | Varsayılan `500` (üstel geri çekilme tabanı) |
| `TRENDYOL_TIMEOUT_MS` | — | Varsayılan `15000` |

## Çalıştırma

```bash
npm run dev        # http://localhost:3000
```

- `/questions` — son 50 soru (soru metni, ürün adı, tarih, Trendyol durumu)
- `/api/health` — uygulama + veritabanı durumu
- `/api/questions` — sayfalı JSON liste (`?status=&page=&limit=`)
- `POST /api/sync` — Trendyol'dan soruları çeker (salt okunur)

```bash
curl -X POST http://localhost:3000/api/sync
curl "http://localhost:3000/api/questions?status=WAITING_FOR_ANSWER&limit=10"
```

### Gerçek API anahtarı olmadan deneme

Yerleşik sahte sunucu, Trendyol yanıt biçimini taklit eder (yalnızca GET):

```bash
npm run mock:trendyol                     # http://127.0.0.1:5599
TRENDYOL_BASE_URL=http://127.0.0.1:5599/integration/qna npm run dev
curl -X POST http://localhost:3000/api/sync
```

## Trendyol istemcisi

`src/lib/trendyol/client.ts`

- **Basic Auth**: `Authorization: Basic base64(apiKey:apiSecret)` — değer hiçbir yerde loglanmaz.
- **User-Agent**: `{sellerId} - SelfIntegration` (Trendyol dokümantasyonu).
- İlk sorgu: `status=WAITING_FOR_ANSWER`, `page=0`, `size=50`, `orderByField=CreatedDate`,
  `orderByDirection=ASC`.
- Hata sınıflandırması ve tekrar politikası:

| Durum | Davranış |
| --- | --- |
| `401` | Tekrar denenmez, `auth` hatası |
| `403` | Tekrar denenmez, yetki hatası |
| `429` | `Retry-After` başlığına (yoksa varsayılan bekleme) uyarak tekrar dener |
| `5xx` | Üstel geri çekilme ile en fazla `SYNC_MAX_RETRIES` kez tekrar |
| Zaman aşımı / ağ | Aynı şekilde sınırlı tekrar, sonra `TIMEOUT`/`NETWORK` kodu |
| `400/404` vb. | Tekrar denenmez |

## Sayfalama ve upsert

`src/lib/trendyol/sync.ts`

- Sayfalar `page=0`'dan başlar; `last=true`, boş sayfa, kısa sayfa veya `totalPages` sınırında durur.
- Güvenlik sınırı: `SYNC_MAX_PAGES`.
- Tarih filtresi verilirse aralık **en fazla 14 gün** olabilir (`InvalidDateRangeError`).
- Her soru `storeId + trendyolQuestionId` anahtarıyla `upsert` edilir → tekrar çekimde kopya yok.
- Her çalıştırma için `SyncRun` kaydı: başlangıçta `RUNNING`, sonunda `SUCCESS` / `PARTIAL`
  (bazı sayfalar işlendikten sonra hata) / `FAILED`.

## API yanıt doğrulaması

`src/lib/trendyol/schemas.ts`

- Spring Page sarmalayıcısı ve soru nesnesi Zod ile doğrulanır.
- Şemalar **gevşek** (`z.looseObject`): dokümanda listelenen alanlar sıkı doğrulanır, dokümanda
  olmayan ek alanlar `Question.raw` içinde saklanır. **Dokümanda olmayan alan varsayılmaz.**
- Zorunlu alanlar (`id`, `text`) yoksa veya tip uyuşmazsa `TrendyolResponseValidationError`.

> Not: Şemadaki alan adları Trendyol Q&A dokümantasyonuna dayanır. Gerçek API yanıtıyla
> karşılaştırma **gerçek kimlik bilgileriyle** yapılmalıdır; elde olmayan bir yanıt için
> "entegrasyon doğrulandı" iddiası bu projede yer almaz. Alan adı farkı çıkarsa düzeltme noktası
> `trendyolQuestionSchema` ve `normalizeQuestion()` fonksiyonudur.

## Testler

```bash
npm test
```

Vitest, testler için **kendi gömülü PostgreSQL örneğini** (port `55433`, veri dizini `.pgdata/test`)
başlatır ve migration'ları uygular. Kapsam:

- ortam değişkeni doğrulaması ve gizli değer sızdırmama,
- API yanıt şeması, tarih dönüşümleri, durum eşlemesi,
- Basic Auth / User-Agent başlıkları, sorgu parametreleri,
- 401/403/429/5xx/zaman aşımı davranışları ve tekrar sayıları,
- sayfalama bitiş koşulları, `maxPages` sınırı,
- upsert ile kopya oluşmaması, güncelleme tazeliği,
- `SyncRun` başarı/`PARTIAL`/`FAILED` kayıtları,
- HTTP katmanından veritabanına uçtan uca akış.

## Proje yapısı

```
prisma/
  schema.prisma            Store / Question / SyncRun
  migrations/              SQL migration'lar
prisma7.config.ts          Prisma CLI konfigürasyonu (DATABASE_URL)
src/
  app/
    questions/page.tsx     Soru listesi ekranı
    api/health/route.ts    Sağlık kontrolü
    api/questions/route.ts Sayfalı JSON liste
    api/sync/route.ts      Senkronizasyon tetikleyici (POST)
  lib/
    env.ts                 Zod ile ortam doğrulaması
    logger.ts              Gizli bilgi maskeleyen logger
    prisma.ts              Prisma istemcisi (driver adapter)
    trendyol/client.ts     HTTP istemcisi + tekrar politikası
    trendyol/schemas.ts    API yanıt şemaları + normalize
    trendyol/sync.ts       Sayfalama, upsert, SyncRun
scripts/
  dev-postgres.ts          Gömülü PostgreSQL (geliştirme)
  mock-trendyol.ts         Sahte Trendyol API'si (geliştirme)
tests/                     Vitest testleri + global setup
```

## Güvenlik

- `.env` Git'e eklenmez (`.gitignore`).
- API anahtarları, Basic Auth başlığı, müşteri verisi loglanmaz; logger hassas anahtarları ve
  `Basic ...`/`Bearer ...` kalıplarını maskeler.
- Hata mesajları yalnızca HTTP kodu / hata sınıfı içerir.
- Üretim API'sine sadece soru **okuma** isteği gider.

## Bilinen sınırlar (Faz 1)

- Cevap gönderme, ürün/sipariş işlemleri yok (bilinçli).
- Kimlik doğrulama/çoklu kullanıcı yok; tek satıcı `.env` üzerinden yapılandırılır.
- Zamanlanmış senkronizasyon yok; `POST /api/sync` ile manuel tetiklenir.
