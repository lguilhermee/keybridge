import { useRef, useState } from "react";
import { api } from "../../shared/api";
import { useMessage } from "../../shared/ui/message";
import type { ModelTestState } from "./ModelTestResult";
import { errorText } from "./modelEditing";

export type ModelTestTarget = { model_hash: string; display_name: string };

export type ModelTests = ReturnType<typeof useModelTests>;

/** Shared connectivity-test state: per-model running tests, results, and the batch "test all" run. */
export function useModelTests() {
  const message = useMessage();
  const activeModelTests = useRef(new Map<string, { testId: string; controller: AbortController; cancelling: boolean }>());
  const [testingModelHashes, setTestingModelHashes] = useState<Set<string>>(() => new Set());
  const [testResults, setTestResults] = useState<Map<string, ModelTestState>>(() => new Map());
  const [batchTesting, setBatchTesting] = useState(false);

  const cancelTest = async (modelHash: string) => {
    const active = activeModelTests.current.get(modelHash);
    if (!active || active.cancelling) return;
    active.cancelling = true;
    active.controller.abort();
    try {
      await api.cancelModelTest(modelHash, active.testId);
    } catch (cause) {
      message(t("Failed to cancel test: {error}", { error: errorText(cause) }), { duration: 5000 });
    }
  };

  const cancelAllTests = async () => {
    await Promise.all([...activeModelTests.current.keys()].map((modelHash) => cancelTest(modelHash)));
  };

  const testModel = async (model: ModelTestTarget, notify = true): Promise<"success" | "failure" | "cancelled"> => {
    if (activeModelTests.current.has(model.model_hash)) {
      await cancelTest(model.model_hash);
      return "cancelled";
    }
    const active = { testId: crypto.randomUUID(), controller: new AbortController(), cancelling: false };
    activeModelTests.current.set(model.model_hash, active);
    setTestingModelHashes((current) => new Set(current).add(model.model_hash));
    try {
      const result = await api.testModel(model.model_hash, active.testId, active.controller.signal);
      setTestResults((current) => new Map(current).set(model.model_hash, { status: "success", result }));
      if (notify) message(t("Connectivity test for {model} succeeded ({duration} ms)", { model: model.display_name, duration: result.duration_ms }));
      return "success";
    } catch (cause) {
      if (active.cancelling || active.controller.signal.aborted) {
        setTestResults((current) => new Map(current).set(model.model_hash, { status: "cancelled" }));
        return "cancelled";
      }
      const error = errorText(cause);
      setTestResults((current) => new Map(current).set(model.model_hash, { status: "error", error }));
      if (notify) message(t("Connectivity test failed: {error}", { error }), { duration: 5000 });
      return "failure";
    } finally {
      if (activeModelTests.current.get(model.model_hash) === active) activeModelTests.current.delete(model.model_hash);
      setTestingModelHashes((current) => {
        const next = new Set(current);
        next.delete(model.model_hash);
        return next;
      });
    }
  };

  const testAllModels = async (testTargets: ModelTestTarget[]) => {
    if (!testTargets.length || batchTesting) return;
    setBatchTesting(true);
    try {
      const results = await Promise.all(testTargets.map((model) => testModel(model, false)));
      const successful = results.filter((result) => result === "success").length;
      const failed = results.filter((result) => result === "failure").length;
      const cancelled = results.filter((result) => result === "cancelled").length;
      message(cancelled > 0
        ? t("Connectivity test cancelled: {successful} succeeded, {failed} failed", { successful, failed })
        : failed === 0
          ? t("Connectivity tests succeeded for all {count} models", { count: testTargets.length })
          : t("Connectivity tests completed: {successful} succeeded, {failed} failed", { successful, failed }),
      { duration: failed === 0 && cancelled === 0 ? 2400 : 5000 });
    } finally {
      setBatchTesting(false);
    }
  };

  return { testingModelHashes, testResults, batchTesting, testModel, cancelTest, cancelAllTests, testAllModels };
}
