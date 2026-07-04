// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://979d4db4d8a92b900d71cbf77dfcf6d2@o4511674085212160.ingest.us.sentry.io/4511674091700224",

  // Distinguish production / preview / local in the Sentry UI. VERCEL_ENV is set automatically on Vercel.
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,

  // Sample 10% of traces in production to conserve quota; full sampling locally.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  dataCollection: {
    // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#dataCollection
    // userInfo: false,
    // httpBodies: [],
  },
});
