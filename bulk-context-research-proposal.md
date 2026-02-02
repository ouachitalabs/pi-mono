# Bulk Context Loading vs Tool-Based Retrieval for Code Comprehension

**A Research Proposal for Evaluating LLM Oracle Architectures**

*Author: John McCrary / Ouachita Labs*
*Date: February 2026*

---

## Abstract

Current coding agents rely heavily on tool-based retrieval (grep, file search, iterative exploration) to understand large codebases. This approach mirrors how human developers work but may not be optimal for LLMs, which can process large context windows in parallel. This research proposes an experiment to measure whether bulk-loading relevant code context into a read-only "oracle" sub-agent improves code comprehension accuracy compared to traditional tool-based retrieval, using the Linux kernel as a test corpus.

The hypothesis is that bulk context loading will outperform tool-based retrieval on tasks requiring cross-file understanding, particularly for security vulnerabilities and architectural questions that span multiple subsystems.

---

## Motivation

### The Context Rot Misconception

There's a pervasive fear in the applied AI community that large context windows inevitably lead to "context rot" - degraded model performance as context size increases. However, recent research suggests this concern is overblown for single-turn tasks. [Multi-turn conversations degrade context faster than single-turn information dumps](https://arxiv.org/html/2505.06120v1), meaning a model reading a large codebase in one pass may perform better than one iteratively building understanding through tool calls.

### Current Agent Architecture Limitations

Tools like Cursor's "oracle" and Amp Code's specialized sub-agents currently use the same retrieval patterns as the main coding agent - grep, file search, and iterative exploration. This design choice assumes that what works for humans (targeted search) also works for LLMs. But LLMs have fundamentally different capabilities:

- They can process 100k+ tokens simultaneously
- They don't experience "information overload" the way humans do
- Tool call overhead adds latency and potential for retrieval errors

### The Opportunity

If bulk loading outperforms tool-based retrieval for code comprehension, it would suggest a different architectural pattern for coding agents: pre-load relevant subsystems into context before reasoning, rather than searching on-demand. This is particularly relevant as context windows continue to expand (Gemini at 2M tokens, anticipated growth in Claude and GPT models).

---

## Research Questions

1. **Primary:** Does bulk-loading code context into a read-only oracle improve accuracy on code comprehension tasks compared to tool-based retrieval?

2. **Secondary:** What types of questions benefit most from bulk loading vs. tool-based retrieval?

3. **Exploratory:** Is there a context size threshold beyond which bulk loading performance degrades?

---

## Experimental Design

### Test Corpus: Linux Kernel

The Linux kernel is an ideal test corpus for several reasons:

- **Scale:** 28M+ lines of code, forcing real decisions about what to include
- **Documentation quality:** Commit messages, CVE reports, and mailing list archives provide ground truth
- **Subsystem isolation:** Components like ext4, networking, and memory management are relatively self-contained
- **Public availability:** No IP concerns, fully reproducible

#### Selected Subsystems

For tractable experimentation, focus on these subsystems:

| Subsystem | Location | Approx LOC | Rationale |
|-----------|----------|------------|-----------|
| ext4 filesystem | `fs/ext4/` | ~50k | Well-documented bugs, self-contained |
| Memory management (core) | `mm/` | ~150k | Cross-cutting concerns, security-critical |
| IOMMU framework | `drivers/iommu/` | ~80k | Active refactoring history, cross-platform |

### Independent Variables

**Retrieval Strategy (Primary IV)**

1. **Tool-Based Retrieval (Control):** Standard Claude Code / agentic approach
   - Access to: `grep`, `find`, `cat`, file search tools
   - No pre-loaded context beyond the question
   - Model iteratively explores codebase to answer questions

2. **Bulk Context Loading (Treatment):** Custom oracle with pre-loaded context
   - Relevant subsystem files loaded into context window before question
   - No tool access (read-only)
   - Model answers from pre-loaded context only

3. **Hybrid (Exploratory):** Bulk load core files + tools for edge cases
   - Core subsystem files pre-loaded
   - Tools available for files outside pre-loaded set

**Context Size (Secondary IV)**

- Small: ~25k tokens (single file + immediate dependencies)
- Medium: ~50k tokens (core subsystem)
- Large: ~100k tokens (full subsystem with related headers)

**Model (Controlled)**

- Primary: Claude Sonnet 4 (cost-effective for many runs)
- Validation: GPT-5.1-codex-max (hyper-literal model for comparison)

### Dependent Variables

**Primary DV: Localization Accuracy**

For each question, measure:

- **File-level accuracy:** Did the model identify the correct file(s)?
- **Function-level accuracy:** Did the model identify the correct function(s)?
- **Precision:** Of files/functions identified, what fraction were relevant?
- **Recall:** Of relevant files/functions, what fraction were identified?

**Secondary DVs**

- **Token usage:** Total tokens consumed (input + output)
- **Latency:** Time to answer
- **Cost:** Estimated API cost per question

### Question Categories

#### Category 1: Security Vulnerability Localization

Source questions from CVE reports. The CVE description serves as the question; the patch diff provides ground truth.

**Example sources:**
- [CVE Details - Linux Kernel](https://www.cvedetails.com/vulnerability-list/vendor_id-33/product_id-47/Linux-Linux-Kernel.html)
- [Linux Kernel CVE Tracking (GitHub)](https://github.com/nluedtke/linux_kernel_cves)
- [Kernel.org CVE Documentation](https://docs.kernel.org/process/cve.html)

**Example question:**
> "CVE-2016-5195 (Dirty COW): A race condition in the memory subsystem's copy-on-write handling allows local privilege escalation. Identify the vulnerable code locations."

**Ground truth:** `mm/gup.c` (follow_page_pte, __get_user_pages), `include/linux/mm.h` ([commit 19be0eaffa3a](https://github.com/torvalds/linux/commit/19be0eaffa3ac7d8eb6784ad9bdbc7d67ed8e619))

#### Category 2: Bug Localization from Symptoms

Source questions from closed bug reports where symptoms are described but root cause required investigation.

**Example sources:**
- [Kernel Bugzilla](https://bugzilla.kernel.org/)
- [LKML Archives](https://lore.kernel.org/linux-kernel/)
- [Syzkaller Bug Reports](https://github.com/google/syzkaller/blob/master/docs/linux/reporting_kernel_bugs.md)

**Example question:**
> "Mount fails with kmemleak warning after ext4_mark_recovery_complete() returns error. Quotas appear to leak. Where is the bug?"

**Ground truth:** Error path in mount doesn't call quota shutdown ([reference](https://stack.watch/product/linux/linux-kernel/))

#### Category 3: Cross-Subsystem Architectural Questions

Questions requiring understanding of how components interact.

**Example question:**
> "Trace the code path when a user process triggers a page fault on a memory-mapped file. Which files are involved?"

**Ground truth:** Manual analysis of mm/memory.c → mm/filemap.c → fs/\*/\*.c paths

#### Category 4: Refactoring / Duplicate Code Identification

Questions about code structure rather than bugs.

**Example sources:**
- [Coccinelle semantic patches](https://en.wikipedia.org/wiki/Coccinelle_(software))
- [Kernel cleanup patch series on LKML](https://lkml.kernel.org/lkml/0dd0f4c9-37a6-0418-3f19-22c40ccc8265@linux.intel.com/t/)

**Example question:**
> "The IOMMU subsystem has similar domain initialization code across multiple drivers. Identify functions that could be consolidated."

**Ground truth:** [IOMMU refactoring patch series](https://lwn.net/Articles/960017/)

### Sample Size

- **Minimum viable:** 30 questions (10 per category 1-3)
- **Target:** 50 questions for statistical power
- **Per question:** 3 runs per condition to account for model variance

Total runs: 50 questions × 3 conditions × 3 runs = 450 API calls

---

## Implementation Plan

### Phase 1: Tooling Development (Week 1)

**Bulk Context Loader**

Build a CLI tool that:
1. Takes a subsystem path (e.g., `fs/ext4/`)
2. Recursively collects `.c` and `.h` files
3. Counts tokens using tiktoken
4. Concatenates files with clear delimiters
5. Outputs formatted context block for API injection

```python
# Pseudocode
def load_subsystem(path: str, max_tokens: int = 100_000) -> str:
    files = collect_files(path, extensions=['.c', '.h'])
    context = ""
    for f in prioritize_by_importance(files):
        content = f"\\n--- {f.path} ---\\n{f.read()}"
        if count_tokens(context + content) > max_tokens:
            break
        context += content
    return context
```

**Evaluation Harness**

Build a test runner that:
1. Loads questions from YAML/JSON
2. Runs each question against both conditions
3. Captures responses and token usage
4. Outputs structured results for analysis

### Phase 2: Question Curation (Week 1-2)

1. Pull 20 CVEs from ext4/mm subsystems with clear patches
2. Find 15 bug reports with good symptom descriptions
3. Develop 10 architectural questions with manual ground truth
4. Document 5 refactoring opportunities from cleanup patches

### Phase 3: Experiment Execution (Week 2)

1. Run all questions through tool-based condition
2. Run all questions through bulk-loaded condition
3. Run exploratory hybrid condition on subset
4. Collect all metrics

### Phase 4: Analysis and Writeup (Week 3)

1. Score all responses against ground truth
2. Statistical comparison of conditions
3. Qualitative analysis of failure modes
4. Write blog post with findings

---

## Expected Outcomes

### Hypothesis 1: Bulk loading improves accuracy on cross-file questions

Prediction: For questions requiring understanding of multiple files (Categories 2-4), bulk loading will show 15-30% improvement in recall.

Rationale: Tool-based retrieval may miss relevant files if the model doesn't know to look for them. Bulk loading guarantees all relevant code is available.

### Hypothesis 2: Tool-based retrieval is more token-efficient for narrow questions

Prediction: For single-file bugs (many Category 1 questions), tool-based retrieval will use fewer tokens while achieving similar accuracy.

Rationale: If the bug is in one function, loading 100k tokens of context is wasteful.

### Hypothesis 3: Hybrid approach achieves best overall performance

Prediction: Bulk loading core files + tools for exploration will match or exceed both pure approaches.

Rationale: Combines the comprehensive coverage of bulk loading with the flexibility of tools for edge cases.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Questions too easy (both conditions ace them) | Medium | High | Include difficult cross-subsystem questions |
| Questions too hard (neither condition succeeds) | Medium | Medium | Pilot test questions, adjust difficulty |
| Ground truth ambiguous | High | Medium | Use CVEs with clear single-commit fixes |
| Model variance obscures signal | Medium | Medium | Multiple runs per condition, statistical tests |
| Context window limits reached | Low | High | Start with smaller subsystems, scale up |

---

## Success Criteria

The experiment is successful if:

1. **Clear signal:** One condition outperforms another by >10% on primary metric with p < 0.05
2. **Actionable insight:** Results suggest specific architectural recommendations for coding agents
3. **Publishable:** Findings are novel enough to generate interest on HN/Twitter

---

## Resources Required

- **Compute:** ~$50-100 in API costs (450 calls × ~$0.10-0.20 average)
- **Time:** ~20 hours over 3 weeks
- **Data:** Linux kernel source (free), CVE databases (free)

---

## Appendix A: Key Sources

### CVE and Bug Sources
- [CVE Details - Linux Kernel Vulnerabilities](https://www.cvedetails.com/vulnerability-list/vendor_id-33/product_id-47/Linux-Linux-Kernel.html)
- [Linux Kernel CVE Tracking Repository](https://github.com/nluedtke/linux_kernel_cves)
- [Kernel.org CVE Process Documentation](https://docs.kernel.org/process/cve.html)
- [Kernel Security Bug Reporting](https://docs.kernel.org/next/admin-guide/security-bugs.html)
- [Syzkaller Bug Reporting Guide](https://github.com/google/syzkaller/blob/master/docs/linux/reporting_kernel_bugs.md)

### Refactoring and Cleanup Examples
- [IOMMU Cleanup and Refactoring Patch Series](https://lkml.kernel.org/lkml/0dd0f4c9-37a6-0418-3f19-22c40ccc8265@linux.intel.com/t/)
- [IOMMU Page Fault Refactoring (LWN)](https://lwn.net/Articles/960017/)
- [Coccinelle Semantic Patching](https://en.wikipedia.org/wiki/Coccinelle_(software))
- [Kernel Patch Philosophy](https://kernelnewbies.org/PatchPhilosophy)

### Specific CVE Examples
- [Dirty COW (CVE-2016-5195)](https://dirtycow.ninja/) - Race condition in mm/gup.c
- [CVE-2024-43828](https://ogma.in/cve-2024-43828-resolving-the-ext4-fast-commit-infinite-loop-vulnerability-in-linux) - ext4 fast commit infinite loop
- [Red Hat Dirty COW Analysis](https://www.redhat.com/en/blog/understanding-and-mitigating-dirty-cow-vulnerability)

### Context Window Research
- [Multi-turn vs Single-turn Context Degradation](https://arxiv.org/html/2505.06120v1)
- [Google Gemini Long Context](https://ai.google.dev/gemini-api/docs/long-context)

---

## Appendix B: Example Question Format

```yaml
questions:
  - id: cve-2016-5195
    category: security_vulnerability
    difficulty: medium
    
    question: |
      CVE-2016-5195 (Dirty COW): A race condition was found in the way 
      the Linux kernel's memory subsystem handled the copy-on-write (COW) 
      breakage of private read-only memory mappings. An unprivileged local 
      user could use this flaw to gain write access to otherwise read-only 
      memory mappings. Identify the vulnerable code locations.
    
    ground_truth:
      files:
        - mm/gup.c
        - include/linux/mm.h
      functions:
        - follow_page_pte
        - __get_user_pages
      commit: 19be0eaffa3ac7d8eb6784ad9bdbc7d67ed8e619
    
    subsystem: mm
    tokens_for_bulk_load: 85000
```

---

## Appendix C: Scoring Rubric

### File-Level Scoring

| Score | Criteria |
|-------|----------|
| 1.0 | All ground truth files identified, no false positives |
| 0.75 | All ground truth files identified, some false positives |
| 0.5 | Majority of ground truth files identified |
| 0.25 | At least one ground truth file identified |
| 0.0 | No ground truth files identified |

### Function-Level Scoring

| Score | Criteria |
|-------|----------|
| 1.0 | Exact function(s) identified |
| 0.5 | Correct file, nearby/related function |
| 0.25 | Correct file, wrong function |
| 0.0 | Wrong file or no answer |

---

*This proposal will be updated as the experiment progresses. Last updated: February 2026*
