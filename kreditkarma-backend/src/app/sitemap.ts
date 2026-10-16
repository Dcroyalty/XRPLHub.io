import { MetadataRoute } from 'next';
import { prisma } from '@/lib/xrplscore-db';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = 'https://www.xrplhub.io';
  const now  = new Date();
  // One page per Yield Desk option (unlisted ones too: their pages stay up). Never let the DB break the sitemap.
  const yieldSlugs = await prisma.yieldOption.findMany({ select: { slug: true, updatedAt: true } }).catch(() => [] as { slug: string; updatedAt: Date }[]);

  return [
    { url: `${base}/yield`, lastModified: now, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${base}/grants`, lastModified: now, changeFrequency: 'daily', priority: 0.8 },
    { url: `${base}/grants/ledger`, lastModified: now, changeFrequency: 'daily', priority: 0.5 },
    { url: `${base}/pro`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/developers`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/yield/best-xrp-yield`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/yield/method`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    ...yieldSlugs.map((y) => ({ url: `${base}/yield/${y.slug}`, lastModified: y.updatedAt, changeFrequency: 'daily' as const, priority: 0.7 })),
    {
      url:              `${base}`,
      lastModified:     now,
      changeFrequency:  'daily',
      priority:         1.0,
    },
    {
      url:              `${base}/send-many`,
      lastModified:     now,
      changeFrequency:  'monthly',
      priority:         0.8,
    },
    {
      url:              `${base}/lending`,
      lastModified:     now,
      changeFrequency:  'hourly',
      priority:         0.9,
    },
    {
      url:              `${base}/lending/method`,
      lastModified:     now,
      changeFrequency:  'monthly',
      priority:         0.6,
    },
    {
      url:              `${base}/permissions`,
      lastModified:     now,
      changeFrequency:  'monthly',
      priority:         0.8,
    },
    {
      url:              `${base}/spend`,
      lastModified:     now,
      changeFrequency:  'monthly',
      priority:         0.7,
    },
    {
      url:              `${base}/#only`,
      lastModified:     now,
      changeFrequency:  'weekly',
      priority:         0.9,
    },
    {
      url:              `${base}/#score`,
      lastModified:     now,
      changeFrequency:  'daily',
      priority:         0.9,
    },
    {
      url:              `${base}/#grants`,
      lastModified:     now,
      changeFrequency:  'daily',
      priority:         0.8,
    },
    {
      url:              `${base}/pricing`,
      lastModified:     now,
      changeFrequency:  'weekly',
      priority:         0.9,
    },
    {
      url:              `${base}/donate`,
      lastModified:     now,
      changeFrequency:  'weekly',
      priority:         0.7,
    },
    {
      url:              `${base}/terms`,
      lastModified:     now,
      changeFrequency:  'monthly',
      priority:         0.3,
    },
    {
      url:              `${base}/privacy`,
      lastModified:     now,
      changeFrequency:  'monthly',
      priority:         0.3,
    },
    {
      url:              `${base}/support`,
      lastModified:     now,
      changeFrequency:  'monthly',
      priority:         0.4,
    },
  ];
}
