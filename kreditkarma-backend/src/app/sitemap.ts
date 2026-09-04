import { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://xrplhub.io';
  const now  = new Date();

  return [
    {
      url:              `${base}`,
      lastModified:     now,
      changeFrequency:  'daily',
      priority:         1.0,
    },
    {
      url:              `${base}/#products`,
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
