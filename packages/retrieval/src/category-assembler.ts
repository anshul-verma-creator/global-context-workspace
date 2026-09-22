import type { ContextObject } from '@context-workspace/protocol';
import type { CategoryResult, ValidatedDecision, RetrievalQuery } from './retrieval-query.js';
import type { DecisionValidityResolver } from './decision-validity.js';
import type { ScoredCandidate } from './retrieval-engine.js';

/**
 * Category-aware context assembler.
 *
 * Takes all scored candidates and organises them into the 10 required
 * context categories. Run after BM25/FTS, before final rerank.
 *
 * Required categories (per user specification):
 * 1.  current_active_work       — active TASKs + INTENTs
 * 2.  latest_applicable_decisions — ACTIVE decisions (post-supersession resolution)
 * 3.  superseded_decisions       — SUPERSEDED decisions (historical context)
 * 4.  constraints                — active CONSTRAINTs
 * 5.  latest_errors              — most recent ERRORs (up to 5)
 * 6.  latest_test_results        — most recent TEST_RESULTs (up to 5)
 * 7.  active_conflicts           — STATE objects tagged as conflicts
 * 8.  placeholders               — PLACEHOLDERs in candidate/active/confirmed
 * 9.  handoffs                   — HANDOFF objects
 * 10. relevant_code_resources    — CODE_REFERENCEs + OBSERVATIONs tied to query resources
 *
 * Design notes:
 * - The assembler does NOT re-rank. It classifies what's already retrieved.
 * - Each object may appear in multiple categories (e.g., a superseded decision
 *   appears in superseded_decisions but NOT in latest_applicable_decisions).
 * - Objects not matching any category are still returned in the main candidates
 *   list by the engine; the category breakdown is additional metadata.
 */
export class CategoryAssembler {
  private readonly validityResolver: DecisionValidityResolver;

  constructor(validityResolver: DecisionValidityResolver) {
    this.validityResolver = validityResolver;
  }

  assemble(candidates: ScoredCandidate[], query: RetrievalQuery): CategoryResult {
    const resourceSet = new Set(query.resources ?? []);
    const objects = candidates.map((c) => c.object);

    // --- 1. Current active work ---
    const currentActiveWork = objects.filter(
      (o) =>
        (o.type === 'TASK' || o.type === 'INTENT') &&
        (o.status === 'active' || o.status === 'confirmed'),
    );

    // --- 2 & 3. Decisions — resolve validity for the whole batch ---
    const allDecisions = objects.filter((o) => o.type === 'DECISION');
    const resolvedDecisions = this.validityResolver.resolveBatch(allDecisions);

    const latestApplicableDecisions: ValidatedDecision[] = resolvedDecisions.filter(
      (d) => d.validity === 'ACTIVE' || d.validity === 'UNKNOWN',
    );

    const supersededDecisions: ValidatedDecision[] = resolvedDecisions.filter(
      (d) => d.validity === 'SUPERSEDED',
    );

    // --- 4. Constraints ---
    const constraints = objects.filter(
      (o) => o.type === 'CONSTRAINT' && o.status !== 'archived' && o.status !== 'rejected',
    );

    // --- 5. Latest errors (up to 5, newest first) ---
    const latestErrors = objects
      .filter((o) => o.type === 'ERROR')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);

    // --- 6. Latest test results (up to 5, newest first) ---
    const latestTestResults = objects
      .filter((o) => o.type === 'TEST_RESULT')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);

    // --- 7. Active conflicts ---
    // Conflict objects are stored as STATE type with a special content marker,
    // or as dedicated objects with status 'active' and content.kind === 'state'
    // with key matching a conflict pattern, or through the CONFLICTS_WITH relation.
    // We identify them by looking for STATE objects whose content.key starts with 'conflict:'
    const activeConflicts = objects.filter((o) => {
      if (o.type !== 'STATE') return false;
      const content = o.content;
      if (content.kind !== 'state') return false;
      return content.key.startsWith('conflict:') && o.status === 'active';
    });

    // --- 8. Placeholders ---
    const placeholders = objects.filter(
      (o) =>
        o.type === 'PLACEHOLDER' &&
        (o.status === 'candidate' || o.status === 'active' || o.status === 'confirmed'),
    );

    // --- 9. Handoffs ---
    const handoffs = objects.filter((o) => o.type === 'HANDOFF');

    // --- 10. Relevant code resources ---
    // CODE_REFERENCE and OBSERVATION objects that are tied to one of the query resources
    const relevantCodeResources = objects.filter((o) => {
      if (o.type !== 'CODE_REFERENCE' && o.type !== 'OBSERVATION') return false;
      if (resourceSet.size === 0) return o.type === 'CODE_REFERENCE' || o.type === 'OBSERVATION';
      if (o.resource === undefined) return false;
      for (const res of resourceSet) {
        if (o.resource === res || o.resource.startsWith(res) || res.startsWith(o.resource)) {
          return true;
        }
      }
      return false;
    });

    return {
      currentActiveWork,
      latestApplicableDecisions,
      supersededDecisions,
      constraints,
      latestErrors,
      latestTestResults,
      activeConflicts,
      placeholders,
      handoffs,
      relevantCodeResources,
    };
  }
}

/**
 * Annotate candidates that were surfaced by category assembly with the
 * 'category' stage marker. Returns new candidate array.
 */
export function annotateCategoryStage(
  candidates: ScoredCandidate[],
  categoryObjects: Set<string>,
): ScoredCandidate[] {
  return candidates.map((c) => {
    if (categoryObjects.has(c.object.id) && !c.stages.includes('category')) {
      return { ...c, stages: [...c.stages, 'category'] };
    }
    return c;
  });
}
