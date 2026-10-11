# AI Operator — جرد الوظائف (Control / API Inventory)

> الحالة النهائية للميزات والإصدار في `AI_OPERATOR_RELEASE_REPORT.md`. هذا الملف جرد تقني فقط (نتيجة فحص الأزرار في متصفح حقيقي + مسارات الـAPI).

## 2) فحص الأزرار في متصفح حقيقي (ضغط/تعديل كل عنصر ظاهر في 11 شاشة)

| الوضع | إجمالي | له أثر | صامت | خطأ JS | معطّل | مكرر لكل صف |
|---|---|---|---|---|---|---|
| SHADOW | 206 | 122 | 21 | 0 | 11 | 46 |
| APPROVAL | 189 | 117 | 25 | 0 | 2 | 38 |

**الصامت** = حقول تُحفظ بزر الحفظ (حدود الميزانية/السقوف) + زر الوضع الحالي نفسه (ضغطه لا يغيّر شيئًا). لا يوجد زر ميت. الأزرار المعطّلة أصبحت تذكر السبب في الـ tooltip (الموافقة الجماعية، حفظ السياسة، معاينة النتائج).

## 3) الجرد حسب الـ API (153 مسار تحت /api/operator)

- WORKING (واجهة + اختبار): **126** · WORKING API فقط (اختبار، بدون زر): **21** · بدون اختبار مرجعي: **6**
- بدون اختبار مرجعي: `POST /integration/autofix`، `POST /evaluate`، `GET /campaigns`، `PUT /campaigns/:id/tag`، `POST /mapping/confirm-family`، `GET /mapping/health`

| المجال | المسارات | WORKING | API فقط | بدون اختبار |
|---|---|---|---|---|
| daily-plan | 21 | 20 | 1 | 0 |
| decisions | 10 | 10 | 0 | 0 |
| rules | 9 | 9 | 0 | 0 |
| pricing | 8 | 7 | 1 | 0 |
| mapping | 8 | 5 | 1 | 2 |
| product-rules | 7 | 7 | 0 | 0 |
| setup-grid | 6 | 3 | 3 | 0 |
| inventory | 6 | 0 | 6 | 0 |
| automation | 6 | 5 | 1 | 0 |
| integration | 5 | 4 | 0 | 1 |
| budget-optimizer | 5 | 2 | 3 | 0 |
| products | 3 | 3 | 0 | 0 |
| approvals | 3 | 3 | 0 | 0 |
| exceptions | 3 | 3 | 0 | 0 |
| import | 3 | 3 | 0 | 0 |
| autopilot-gate | 3 | 3 | 0 | 0 |
| pause-policy | 3 | 3 | 0 | 0 |
| manual | 3 | 3 | 0 | 0 |
| execution-permissions | 2 | 2 | 0 | 0 |
| budget-caps | 2 | 2 | 0 | 0 |
| execution-history | 2 | 2 | 0 | 0 |
| brief | 2 | 2 | 0 | 0 |
| emergency-stop | 2 | 2 | 0 | 0 |
| campaigns | 2 | 0 | 0 | 2 |
| product-config | 2 | 0 | 2 | 0 |
| templates | 2 | 2 | 0 | 0 |
| coverage | 1 | 1 | 0 | 0 |
| overview | 1 | 1 | 0 | 0 |
| config | 1 | 1 | 0 | 0 |
| smart-alerts | 1 | 0 | 1 | 0 |
| campaign-metrics | 1 | 1 | 0 | 0 |
| campaign-board | 1 | 1 | 0 | 0 |
| product-images | 1 | 1 | 0 | 0 |
| status-bar | 1 | 1 | 0 | 0 |
| monitoring | 1 | 1 | 0 | 0 |
| production-readiness | 1 | 1 | 0 | 0 |
| control | 1 | 0 | 1 | 0 |
| auto-actions | 1 | 1 | 0 | 0 |
| mode | 1 | 1 | 0 | 0 |
| limits | 1 | 1 | 0 | 0 |
| evaluate | 1 | 0 | 0 | 1 |
| tick | 1 | 1 | 0 | 0 |
| shadow-report | 1 | 1 | 0 | 0 |
| command | 1 | 1 | 0 | 0 |
| readiness | 1 | 1 | 0 | 0 |
| global-readiness | 1 | 1 | 0 | 0 |
| wizard | 1 | 0 | 1 | 0 |
| audit | 1 | 1 | 0 | 0 |
| what-will-happen | 1 | 1 | 0 | 0 |
| health | 1 | 1 | 0 | 0 |
| performance | 1 | 1 | 0 | 0 |

<details><summary>تفصيل كل مسار (Control | Handler | API | Service | Test | Status)</summary>

| API | Role | Frontend | Backend call | Tests | Status |
|---|---|---|---|---|---|
| `GET /integration` | AUTH | ai-operator-completion.js, opx-integration.js | — | integrationE2ETest, opxUiTest | WORKING |
| `POST /integration/autofix` | ADMIN | ai-operator-completion.js | autoFixIntegration | — | UNTESTED (لا يوجد اختبار مرجعي) |
| `GET /coverage` | AUTH | ai-operator-completion.js | coverageAudit, setupGrid.buildSetupGrid | operatorSetupGridTest | WORKING |
| `GET /setup-grid` | AUTH | ai-operator-grid.js | setupGrid.buildSetupGrid, setupGrid.validateGrid | operatorSetupGridTest, operatorTest | WORKING |
| `POST /setup-grid/validate` | AUTH | — | setupGrid.validateGrid, setupGrid.previewGrid | operatorSetupGridTest, operatorTest | WORKING (API فقط — لا زر في الواجهة) |
| `POST /setup-grid/preview` | AUTH | — | setupGrid.previewGrid, setupGrid.applyGrid | operatorSetupGridTest, operatorTest | WORKING (API فقط — لا زر في الواجهة) |
| `POST /setup-grid/apply` | ADMIN | ai-operator-grid.js | setupGrid.applyGrid, clearOperatorFactsCache | operatorSetupGridTest, operatorTest | WORKING |
| `POST /setup-grid/recompute` | AUTH | ai-operator-grid.js | setupGrid.recomputeReadiness, setupGrid.shadowForProducts | operatorSetupGridTest, operatorTest | WORKING |
| `POST /setup-grid/shadow` | AUTH | — | setupGrid.shadowForProducts, store.setProductOverride | operatorControlTest, operatorSetupGridTest, operatorTest | WORKING (API فقط — لا زر في الواجهة) |
| `PUT /products/:productId/zero-order` | ADMIN | ai-operator-setup.js | store.setProductOverride, clearOperatorFactsCache | operatorControlTest | WORKING |
| `GET /overview` | AUTH | ai-operator-daily.js, ai-operator.js, opx-budget.js, opx-plan.js, opx-shell.js | adAccountId, listCampaignsFromSnapshots | advisorTest, aiGatewayTest, approvalCenterTest, approvePopupJourneyTest | WORKING |
| `GET /config` | AUTH | ai-operator.js, opx-budget.js, opx-plan.js, opx-shell.js | store.getOperatorConfig, getAmbSettings | aiGatewayTest, ambLaunchJobTest, approvalCenterTest, approvePopupJourneyTest | WORKING |
| `GET /inventory` | AUTH | — | inventoryOverview, compareManualVsApi | inventoryDiagnosticsTest, inventoryWebhookTest | WORKING (API فقط — لا زر في الواجهة) |
| `GET /inventory/compare/:productId` | AUTH | — | compareManualVsApi, setInventoryLink | inventoryWebhookTest | WORKING (API فقط — لا زر في الواجهة) |
| `POST /inventory/links` | ADMIN | — | setInventoryLink, removeInventoryLink | inventoryWebhookTest | WORKING (API فقط — لا زر في الواجهة) |
| `DELETE /inventory/links` | ADMIN | — | removeInventoryLink, setInventoryPrimary | inventoryWebhookTest | WORKING (API فقط — لا زر في الواجهة) |
| `PUT /inventory/products/:productId/primary` | ADMIN | — | setInventoryPrimary, compareManualVsApi | inventoryWebhookTest | WORKING (API فقط — لا زر في الواجهة) |
| `POST /inventory/reconcile` | ADMIN | — | runInventoryReconcile | inventoryWebhookTest | WORKING (API فقط — لا زر في الواجهة) |
| `GET /budget-optimizer/policy` | AUTH | opx-budget.js | getBudgetPolicy, setBudgetPolicy | budgetOptimizerTest, productGuardsTest, productPolicyTest | WORKING |
| `PUT /budget-optimizer/policy` | ADMIN | opx-budget.js | setBudgetPolicy, evaluateBudgetOptimization | budgetOptimizerTest, productGuardsTest, productPolicyTest | WORKING |
| `POST /budget-optimizer/preview` | ADMIN | — | evaluateBudgetOptimization, prepareBudgetDecision | budgetCapsAndAlertsTest, budgetExecutionTest, budgetOptimizerTest, productGuardsTest | WORKING (API فقط — لا زر في الواجهة) |
| `POST /budget-optimizer/prepare` | ADMIN | — | prepareBudgetDecision | budgetApprovalRouteTest, budgetCapsAndAlertsTest, budgetExecutionTest | WORKING (API فقط — لا زر في الواجهة) |
| `GET /execution-permissions` | AUTH | ai-operator-perms.js | getExecutionPermissions, setExecutionPermission | budgetCapsAndAlertsTest, executionPermissionsTest | WORKING |
| `PUT /execution-permissions/:key` | ADMIN | ai-operator-perms.js | setExecutionPermission, getBudgetCaps | budgetCapsAndAlertsTest, executionPermissionsTest | WORKING |
| `GET /budget-caps` | AUTH | ai-operator-perms.js, opx-budget.js | getBudgetCaps, setBudgetCaps | budgetCapsAndAlertsTest | WORKING |
| `PUT /budget-caps` | ADMIN | ai-operator-perms.js, opx-budget.js | setBudgetCaps, runSmartAlerts | budgetCapsAndAlertsTest | WORKING |
| `POST /smart-alerts/run` | ADMIN | — | runSmartAlerts, PP.listProductRules | budgetCapsAndAlertsTest, productPolicyTest | WORKING (API فقط — لا زر في الواجهة) |
| `GET /product-rules` | AUTH | opx-rules.js | PP.listProductRules | opxUiTest, productPolicyTest | WORKING |
| `GET /pricing/products` | AUTH | opx-integration.js, opx-pricing.js, opx-rules.js | PP.listProductRules, ambProduct.findMany | advisorTest, ambLaunchJobTest, approvePopupJourneyTest, automationEngineTest | WORKING |
| `GET /pricing/:productId` | AUTH | opx-pricing.js | product.findUnique | advisorTest, ambLaunchJobTest, approvalCenterTest, approvePopupJourneyTest | WORKING |
| `POST /pricing/compute` | AUTH | — | SP.computePricing | integrationE2ETest, operatorTest, smartPricingTest | WORKING (API فقط — لا زر في الواجهة) |
| `POST /pricing/:productId/analyze` | AUTH | opx-pricing.js | SP.computePricing, pricingWindows | integrationE2ETest, smartPricingTest | WORKING |
| `PUT /pricing/:productId/draft` | ADMIN | opx-pricing.js | SP.savePricingDraft, SP.approvePrice | integrationE2ETest, smartPricingTest | WORKING |
| `POST /pricing/:productId/approve` | ADMIN | opx-pricing.js | SP.approvePrice, SP.previewApplyToRules | integrationE2ETest, smartPricingTest | WORKING |
| `POST /pricing/:productId/rules-preview` | ADMIN | opx-pricing.js | SP.previewApplyToRules, SP.applyToRules | integrationE2ETest, smartPricingTest | WORKING |
| `POST /pricing/:productId/rules-apply` | ADMIN | opx-pricing.js | SP.applyToRules, PP.getProductPolicy | integrationE2ETest, productPolicyTest, smartPricingTest | WORKING |
| `GET /product-rules/:productId` | AUTH | opx-rules.js | PP.getProductPolicy, PP.saveDraft | automationPolicyTest, integrationE2ETest, opxUiTest, productPolicyTest | WORKING |
| `PUT /product-rules/:productId/draft` | ADMIN | opx-rules.js | PP.saveDraft, PP.activatePolicy | automationPolicyTest, integrationE2ETest, productPolicyTest, productSchedulingTest | WORKING |
| `POST /product-rules/:productId/activate` | ADMIN | opx-rules.js | PP.activatePolicy, PP.deactivatePolicy | automationPolicyTest, integrationE2ETest, productPolicyTest, productSchedulingTest | WORKING |
| `POST /product-rules/:productId/deactivate` | ADMIN | opx-rules.js | PP.deactivatePolicy, PP.copyPolicy | advisorTest, ambLaunchJobTest, approvalCenterTest, automationPolicyTest | WORKING |
| `POST /product-rules/copy` | ADMIN | opx-rules.js | PP.copyPolicy, PP.listProductRules | advisorTest, ambLaunchJobTest, approvalCenterTest, automationPolicyTest | WORKING |
| `POST /product-rules/:productId/preview` | ADMIN | opx-rules.js | PP.listProductRules, list.find | advisorTest, ambLaunchJobTest, approvalCenterTest, automationPolicyTest | WORKING |
| `GET /execution-history/summary` | AUTH | opx-history.js | todaySummary, clockNow | campaignBoardTest, dailyPlanTest, executionHistoryTest, integrationE2ETest | WORKING |
| `GET /execution-history` | AUTH | opx-history.js | listExecutionHistory, parseWindow | campaignBoardTest, dailyPlanTest, executionHistoryTest, integrationE2ETest | WORKING |
| `GET /campaign-metrics` | AUTH | opx-plan.js | parseWindow, cairoDate | campaignBoardTest, dailyPlanTest, integrationE2ETest, opxUiTest | WORKING |
| `GET /campaign-board` | AUTH | opx-plan.js | buildCampaignBoard, clockNow | approvalCenterTest, campaignBoardTest, centralWriteGateTest, dailyPlanTest | WORKING |
| `GET /product-images` | AUTH | opx-ui.js | productImages, split | approvalCenterTest, centralWriteGateTest, productGuardsTest | WORKING |
| `GET /approvals` | AUTH | ai-operator-approvals.js, opx-approvals.js | listApprovals, bulkPreview | approvalCenterTest, centralWriteGateTest, opxUiTest | WORKING |
| `POST /approvals/bulk-preview` | ADMIN | ai-operator-approvals.js, opx-approvals.js | bulkPreview | approvalCenterTest | WORKING |
| `POST /approvals/bulk` | ADMIN | ai-operator-approvals.js, opx-approvals.js | bulkPreview | approvalCenterTest | WORKING |
| `GET /status-bar` | AUTH | ai-operator-approvals.js, opx-shell.js | statusBar, buildOperatorBrief | approvalCenterTest, postActionMonitoringTest | WORKING |
| `GET /brief` | AUTH | ai-operator-approvals.js, ai-operator-setup.js | buildOperatorBrief, listMonitoredActions | executionPermissionsTest, postActionMonitoringTest, productionReadinessTest | WORKING |
| `GET /monitoring` | AUTH | ai-operator-monitor.js, opx-history.js | listMonitoredActions, buildProductionReadiness | executionPermissionsTest, postActionMonitoringTest, productionReadinessTest | WORKING |
| `GET /production-readiness` | AUTH | ai-operator-daily.js, ai-operator-perms.js | buildProductionReadiness, daily.getOpenCpaOverview | dailyPlanTest, executionPermissionsTest, openCpaPolicyTest, productionReadinessTest | WORKING |
| `GET /daily-plan/open-cpa` | AUTH | opx-open-adv.js, opx-plan.js | daily.getOpenCpaOverview, clockNow | dailyPlanTest, integrationE2ETest, openCpaPolicyTest, openPolicyScopeTest | WORKING |
| `PUT /daily-plan/open-cpa` | ADMIN | opx-open-adv.js, opx-plan.js | OC.saveOpenCpaPolicy, clockNow | dailyPlanTest, integrationE2ETest, openCpaPolicyTest, openPolicyScopeTest | WORKING |
| `POST /daily-plan/open-cpa/enable` | ADMIN | opx-plan.js | OC.setOpenCpaEnabled, clockNow | dailyPlanTest, integrationE2ETest, openCpaPolicyTest, opxUiTest | WORKING |
| `POST /daily-plan/open-cpa/prepare` | ADMIN | opx-plan.js | daily.prepareOpenCpaMatches, clockNow | dailyPlanTest, integrationE2ETest, openCpaPolicyTest, opxUiTest | WORKING |
| `GET /integration/map` | AUTH | opx-integration.js | INT.integrationHealth, clockNow | dailyPlanTest, integrationE2ETest | WORKING |
| `GET /integration/health` | AUTH | opx-integration.js | INT.integrationHealth, clockNow | dailyPlanTest, integrationE2ETest, opxUiTest, productSchedulingTest | WORKING |
| `GET /integration/resolve` | AUTH | opx-integration.js | INT.resolvePolicy, clockNow | dailyPlanTest, integrationE2ETest, productSchedulingTest | WORKING |
| `GET /daily-plan/overview` | AUTH | ai-operator-daily.js, opx-plan.js | daily.getDailyOverview, clockNow | dailyPlanTest, opxUiTest, productSchedulingTest | WORKING |
| `GET /daily-plan/due` | AUTH | ai-operator-daily.js | clockNow, isTestClock | dailyPlanTest, executionPermissionsTest, integrationE2ETest, openCpaPolicyTest | WORKING |
| `GET /daily-plan/preview-tomorrow` | AUTH | ai-operator-daily.js | daily.previewTomorrow, clockNow | dailyPlanTest, executionPermissionsTest, integrationE2ETest, openCpaPolicyTest | WORKING |
| `GET /daily-plan/config` | AUTH | opx-plan.js | daily.getDailyPlanConfig, daily.setDailyPlanConfig | dailyPlanTest, executionPermissionsTest, integrationE2ETest, openCpaPolicyTest | WORKING |
| `PUT /daily-plan/config` | ADMIN | opx-plan.js | daily.setDailyPlanConfig, daily.getPlanById | dailyPlanTest, executionPermissionsTest | WORKING |
| `GET /daily-plan/:id` | AUTH | ai-operator-daily.js, opx-approvals.js, opx-plan.js | daily.getPlanById, daily.planAudit | dailyPlanTest, opxUiTest | WORKING |
| `POST /daily-plan/new` | ADMIN | ai-operator-daily.js, opx-plan.js | daily.startOneOffPlan, clockNow | approvePopupJourneyTest, automaticPlansTest, centralWriteGateTest, dailyPlanTest | WORKING |
| `POST /daily-plan/:id/preview-execution` | ADMIN | ai-operator-daily.js, opx-approvals.js, opx-plan.js | daily.previewExecution, clockNow | approvePopupJourneyTest, automaticPlansTest, campaignBoardTest, centralWriteGateTest | WORKING |
| `POST /daily-plan/prepare` | ADMIN | opx-plan.js | clockNow, daily.preparePlan | approvePopupJourneyTest, automaticPlansTest, campaignBoardTest, centralWriteGateTest | WORKING |
| `PUT /daily-plan/:id/selection` | ADMIN | ai-operator-daily.js, opx-plan.js | daily.updateSelection, clockNow | approvePopupJourneyTest, centralWriteGateTest, dailyPlanTest, integrationE2ETest | WORKING |
| `POST /daily-plan/:id/approve` | ADMIN | ai-operator-daily.js, opx-approvals.js, opx-plan.js | daily.approvePlan, clockNow | approvePopupJourneyTest, centralWriteGateTest, dailyPlanTest, integrationE2ETest | WORKING |
| `POST /daily-plan/:id/cancel` | ADMIN | ai-operator-daily.js, opx-approvals.js, opx-plan.js | daily.cancelPlan, clockNow | dailyPlanTest | WORKING |
| `POST /daily-plan/:id/dismiss` | ADMIN | ai-operator-daily.js | daily.dismissPopup, daily.excludeCampaign | dailyPlanTest | WORKING |
| `POST /daily-plan/exclude` | ADMIN | opx-plan.js | daily.excludeCampaign, clockNow | dailyPlanTest, executionPermissionsTest | WORKING |
| `POST /daily-plan/protect` | ADMIN | opx-plan.js | daily.protectWinner, daily.setDailyPlanConfig | dailyPlanTest, executionPermissionsTest | WORKING |
| `POST /daily-plan/halt` | ADMIN | ai-operator-daily.js, opx-plan.js | daily.setDailyPlanConfig, testClockAllowed | dailyPlanTest, executionPermissionsTest | WORKING |
| `PUT /daily-plan/test-clock` | ADMIN | — | testClockAllowed, setTestClock | budgetOptimizerTest, dailyPlanTest | WORKING (API فقط — لا زر في الواجهة) |
| `GET /budget-optimizer/history` | AUTH | — | budgetActionHistory | budgetApprovalRouteTest, budgetOptimizerTest | WORKING (API فقط — لا زر في الواجهة) |
| `GET /control` | AUTH | — | controlStatus, setAutoActions | creativeFactoryProdTest, operatorControlTest, operatorSetupTest, operatorTest | WORKING (API فقط — لا زر في الواجهة) |
| `PUT /auto-actions` | ADMIN | ai-operator.js, opx-budget.js | setAutoActions, store.setOperatorMode | externalWriteGuardTest, operatorControlTest, operatorSetupTest, operatorTest | WORKING |
| `PUT /mode` | ADMIN | ai-operator-setup.js, ai-operator.js, opx-shell.js | store.setOperatorMode, store.setEmergencyStop | externalWriteGuardTest, operatorControlTest, operatorSetupTest, operatorTest | WORKING |
| `POST /emergency-stop` | AUTH | ai-operator.js, opx-shell.js | store.setEmergencyStop, notifyEmergencyStop | externalWriteGuardTest, operatorControlTest, operatorSetupTest, operatorTest | WORKING |
| `DELETE /emergency-stop` | ADMIN | ai-operator.js, opx-shell.js | store.setEmergencyStop, store.updateOperatorLimits | externalWriteGuardTest, operatorControlTest, operatorSetupTest, operatorTest | WORKING |
| `PUT /limits` | ADMIN | ai-operator-setup.js | store.updateOperatorLimits | operatorSetupTest, operatorTest | WORKING |
| `GET /decisions` | AUTH | ai-operator-approvals.js, ai-operator-setup.js, ai-operator.js, opx-approvals.js, opx-budget.js | listDecisions | budgetApprovalRouteTest, centralWriteGateTest, operatorTest, operatorWritePathTest | WORKING |
| `GET /decisions/:id` | AUTH | ai-operator-approvals.js, ai-operator-setup.js, ai-operator.js, opx-approvals.js | ambOperatorDecision.findUnique | advisorTest, ambLaunchJobTest, approvalCenterTest, approvePopupJourneyTest | WORKING |
| `POST /decisions/:id/approve` | ADMIN | ai-operator-approvals.js, ai-operator.js, opx-approvals.js | approveDecision, previewDecision | automationEngineTest, centralWriteGateTest, operatorSetupTest, operatorTest | WORKING |
| `POST /decisions/:id/preview` | ADMIN | opx-approvals.js | previewDecision, rejectDecision | centralWriteGateTest, operatorSetupTest, operatorTest | WORKING |
| `POST /decisions/:id/reject` | ADMIN | ai-operator-approvals.js, ai-operator.js, opx-approvals.js | rejectDecision, snoozeDecision | operatorSetupTest, operatorTest | WORKING |
| `POST /decisions/:id/snooze` | ADMIN | ai-operator.js | snoozeDecision, shapeDecision | operatorSetupTest, operatorTest | WORKING |
| `POST /decisions/:id/rollback` | ADMIN | ai-operator-setup.js | shapeDecision, prepareRollback | operatorSetupTest, operatorTest | WORKING |
| `POST /evaluate` | ADMIN | ai-operator.js | clearOperatorFactsCache | — | UNTESTED (لا يوجد اختبار مرجعي) |
| `POST /tick` | ADMIN | opx-automation.js | runOperatorTick, shadowReport | operatorControlTest, operatorTest | WORKING |
| `GET /shadow-report` | AUTH | ai-operator-setup.js | shadowReport, legacySummary | operatorTest | WORKING |
| `GET /rules` | AUTH | ai-operator.js, opx-pricing.js | store.listRules, detectRuleConflicts | operatorTest, operatorWritePathTest | WORKING |
| `POST /rules/validate` | AUTH | ai-operator.js | validateRule, detectRuleConflicts | operatorTest, operatorWritePathTest | WORKING |
| `POST /rules/parse` | AUTH | ai-operator.js | parseArabicRule, validateRule | operatorTest, operatorWritePathTest | WORKING |
| `POST /rules/simulate` | AUTH | ai-operator.js | validateRule | operatorTest, operatorWritePathTest | WORKING |
| `POST /rules` | ADMIN | ai-operator.js, opx-pricing.js | store.saveRule | operatorSetupTest, operatorTest, operatorWritePathTest | WORKING |
| `PUT /rules/:id` | ADMIN | ai-operator.js | store.saveRule | operatorSetupTest, operatorTest, operatorWritePathTest | WORKING |
| `POST /rules/:id/enabled` | ADMIN | ai-operator.js | store.setRuleEnabled | operatorSetupTest, operatorTest | WORKING |
| `DELETE /rules/:id` | ADMIN | ai-operator.js | store.deleteRule | operatorTest, operatorWritePathTest | WORKING |
| `GET /exceptions` | AUTH | ai-operator-setup.js, ai-operator.js | store.listExceptions | operatorTest, operatorWritePathTest | WORKING |
| `POST /exceptions` | ADMIN | ai-operator-setup.js, ai-operator.js | store.addException | operatorTest, operatorWritePathTest | WORKING |
| `DELETE /exceptions/:id` | ADMIN | ai-operator-setup.js | store.removeException, adAccountId | operatorTest, operatorWritePathTest | WORKING |
| `GET /campaigns` | AUTH | ai-operator.js | adAccountId | — | UNTESTED (لا يوجد اختبار مرجعي) |
| `PUT /campaigns/:id/tag` | ADMIN | ai-operator.js | adAccountId | — | UNTESTED (لا يوجد اختبار مرجعي) |
| `GET /product-config/:productId` | AUTH | — | product.findUnique | advisorTest, ambLaunchJobTest, approvalCenterTest, approvePopupJourneyTest | WORKING (API فقط — لا زر في الواجهة) |
| `PUT /product-config/:productId` | ADMIN | — | product.findUnique | advisorTest, ambLaunchJobTest, approvalCenterTest, approvePopupJourneyTest | WORKING (API فقط — لا زر في الواجهة) |
| `POST /command` | AUTH | ai-operator-setup.js | interpretCommand | operatorTest | WORKING |
| `GET /readiness` | AUTH | ai-operator-setup.js, opx-automation.js | readiness.readinessList, readiness.globalReadiness | operatorSetupTest, operatorWritePathTest, opxUiTest | WORKING |
| `GET /global-readiness` | AUTH | ai-operator-setup.js | readiness.globalReadiness, adAccountId | operatorSetupTest | WORKING |
| `GET /wizard` | AUTH | — | readiness.setupWizard, adAccountId | operatorSetupTest | WORKING (API فقط — لا زر في الواجهة) |
| `GET /products/:productId/profile` | AUTH | ai-operator-setup.js | readiness.getProductProfile, readiness.saveProductProfile | operatorSetupTest | WORKING |
| `PUT /products/:productId/profile` | ADMIN | ai-operator-setup.js | readiness.saveProductProfile, readiness.mappingCenter | operatorSetupTest | WORKING |
| `GET /mapping` | AUTH | ai-operator-setup.js | readiness.mappingCenter, adAccountId | operatorSetupTest, operatorTest, operatorWritePathTest | WORKING |
| `POST /mapping/confirm` | ADMIN | ai-operator-setup.js | adAccountId | operatorWritePathTest | WORKING |
| `DELETE /mapping/:campaignId` | ADMIN | ai-operator-setup.js | adAccountId, readiness.unmapCampaign | dailyPlanTest, operatorTest, operatorWritePathTest | WORKING |
| `POST /mapping/exclude` | ADMIN | ai-operator-setup.js | readiness.excludeCampaign, adAccountId | dailyPlanTest, operatorWritePathTest | WORKING |
| `POST /mapping/confirm-family` | ADMIN | ai-operator-setup.js | adAccountId | — | UNTESTED (لا يوجد اختبار مرجعي) |
| `GET /mapping/health` | AUTH | — | mappingHealthReport, adAccountId | — | UNTESTED (لا يوجد اختبار مرجعي) |
| `POST /mapping/analyze-landing` | ADMIN | — | adAccountId, analyzeLandingEvidence | operatorLandingEvidenceTest | WORKING (API فقط — لا زر في الواجهة) |
| `POST /mapping/suggest` | ADMIN | ai-operator-setup.js | adAccountId, readiness.persistDeterministicSuggestions | operatorSetupTest | WORKING |
| `GET /import/template` | AUTH | ai-operator-setup.js | readiness.bulkSetupTemplate, readiness.previewBulkSetup | operatorSetupTest, operatorWritePathTest | WORKING |
| `POST /import/preview` | ADMIN | ai-operator-setup.js | readiness.previewBulkSetup, readiness.applyBulkSetup | operatorSetupTest, operatorWritePathTest | WORKING |
| `POST /import/apply` | ADMIN | ai-operator-setup.js | readiness.applyBulkSetup | operatorSetupTest, operatorWritePathTest | WORKING |
| `GET /templates` | AUTH | ai-operator.js | listTemplates, instantiateTemplate | operatorSetupTest, operatorTest, operatorWritePathTest | WORKING |
| `POST /templates/:key/instantiate` | AUTH | ai-operator.js | instantiateTemplate, store.listRules | operatorSetupTest, operatorTest | WORKING |
| `POST /rules/:id/dry-run` | AUTH | ai-operator.js | store.listRules, find | operatorTest | WORKING |
| `GET /audit` | AUTH | ai-operator-setup.js | ruleAuditLog | operatorSetupGridTest, operatorSetupTest, operatorWritePathTest | WORKING |
| `GET /decisions/:id/events` | AUTH | ai-operator-setup.js, opx-approvals.js | decisionEvents, retryFailedDecision | approvalCenterTest, operatorSetupTest | WORKING |
| `POST /decisions/:id/retry` | ADMIN | ai-operator-setup.js | retryFailedDecision, bulkApprove | approvalCenterTest, operatorSetupTest | WORKING |
| `POST /decisions/bulk-approve` | ADMIN | ai-operator.js | bulkApprove, whatWillHappen | approvalCenterTest, operatorSetupTest, operatorWritePathTest | WORKING |
| `POST /what-will-happen` | AUTH | ai-operator-setup.js | whatWillHappen, operatorHealth | operatorSetupTest, operatorTest | WORKING |
| `GET /health` | AUTH | ai-operator-setup.js, opx-integration.js | operatorHealth, getOperatorSchedulerStatus | operatorSetupTest, opxUiTest | WORKING |
| `GET /performance` | AUTH | ai-operator-setup.js | performanceReport, executedWithOutcomes | operatorSetupTest | WORKING |
| `GET /brief` | AUTH | ai-operator-approvals.js, ai-operator-setup.js | dailyBrief, adAccountId | operatorSetupTest | WORKING |
| `GET /autopilot-gate` | AUTH | ai-operator-setup.js | store.autopilotGate, store.attestAutopilot | operatorSetupTest | WORKING |
| `POST /autopilot-gate/attest` | ADMIN | ai-operator-setup.js | store.attestAutopilot, store.autopilotGate | operatorSetupTest | WORKING |
| `DELETE /autopilot-gate/attest` | ADMIN | ai-operator-setup.js | store.revokeAttestations, store.autopilotGate | operatorSetupTest | WORKING |
| `GET /pause-policy` | AUTH | opx-automation.js | PAUSEP.getPausePolicy, history.slice | advisorTest, aiAssistantStoreIsolationTest, ambLaunchJobTest, approvalCenterTest | WORKING |
| `PUT /pause-policy` | ADMIN | opx-automation.js | PAUSEP.savePausePolicy, PAUSEP.setPausePolicyEnabled | automaticPlansTest, automationPolicyTest, budgetApprovalRouteTest, budgetExecutionTest | WORKING |
| `POST /pause-policy/enable` | ADMIN | opx-automation.js | PAUSEP.setPausePolicyEnabled, store.getOperatorConfig | automaticPlansTest, automationPolicyTest, budgetApprovalRouteTest, budgetExecutionTest | WORKING |
| `GET /automation/status` | AUTH | opx-automation.js | store.getOperatorConfig, daily.getDailyPlanConfig | aiAssistantStoreIsolationTest, budgetApprovalRouteTest, budgetExecutionTest, budgetOptimizerTest | WORKING |
| `GET /automation/candidates` | ADMIN | opx-automation.js | AUTO.evaluateAutomation, clockNow | advisorTest, automationEngineTest, centralWriteGateTest, customersUnlinkedOrdersTest | WORKING |
| `POST /automation/tick` | ADMIN | opx-automation.js | AUTO.runAutomationTick, AREADY.automationReadinessMap | advisorTest, automationEngineTest, centralWriteGateTest, customersUnlinkedOrdersTest | WORKING |
| `GET /automation/readiness` | AUTH | opx-automation.js | AREADY.automationReadinessMap, m.values | advisorTest, automationPolicyTest, centralWriteGateTest, customersUnlinkedOrdersTest | WORKING |
| `GET /automation/readiness/:productId` | AUTH | — | AREADY.productAutomationReadiness, AREADY.activationSummary | aiGatewayTest, automationPolicyTest, centralWriteGateTest, easyOrdersStatusSyncTest | WORKING (API فقط — لا زر في الواجهة) |
| `GET /automation/activation-summary/:productId` | AUTH | opx-automation.js | AREADY.activationSummary, adAccountId | aiGatewayTest, automationPolicyTest, centralWriteGateTest, easyOrdersStatusSyncTest | WORKING |
| `GET /manual/targets` | AUTH | opx-manual.js | adAccountId, trim | aiGatewayTest, centralWriteGateTest, easyOrdersStatusSyncTest, operationsMockTest | WORKING |
| `POST /manual/preflight` | ADMIN | opx-manual.js | MANUAL.manualPreflight, MANUAL.manualExecute | manualOperationsTest, opxUiTest | WORKING |
| `POST /manual/execute` | ADMIN | opx-manual.js | MANUAL.manualExecute | manualOperationsTest, opxUiTest | WORKING |

</details>

