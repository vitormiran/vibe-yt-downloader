'use client';

import posthog from 'posthog-js';
import { useEffect } from 'react';

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) return;

    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN, {
      // Route through the /ingest rewrites in next.config.ts to avoid ad blockers
      api_host: '/ingest',
      ui_host: 'https://us.posthog.com',
      capture_pageview: false, // SPA — page views tracked manually if needed
      persistence: 'localStorage+cookie',
    });
  }, []);

  return <>{children}</>;
}
