import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow:     '/',
        disallow:  ['/admin', '/api/', '/xapp/'], // /xapp/ only works inside the Xaman app
      },
    ],
    sitemap: 'https://www.xrplhub.io/sitemap.xml',
    host:    'https://www.xrplhub.io',
  };
}
