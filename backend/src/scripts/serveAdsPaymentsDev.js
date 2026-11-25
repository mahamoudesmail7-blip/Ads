// Local review server for the Ads Payment Center: the real server on the ISOLATED test database, with the payment SIMULATOR switched on (it is refused anywhere else).
//   node src/scripts/adsPaymentsDevSeed.js   (once — sample SIMULATED data)   then   node src/scripts/serveAdsPaymentsDev.js   → http://localhost:4000/ai-media-buyer.html#payments
//   login: test-owner@example.invalid · password: Test-Owner-Only-2026!  (test database only)
process.env.ADS_PAYMENTS_SIMULATION = '1';
await import('./serveOnTestDb.js');
