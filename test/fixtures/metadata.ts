import type { PaperMetadata } from "../../src/arxiv/atom.js";

export function makeMetadata(overrides: Partial<PaperMetadata> = {}): PaperMetadata {
  return {
    id: "2211.17192",
    version: 2,
    exactId: "2211.17192v2",
    title: "Fast Inference from Transformers via Speculative Decoding",
    summary: "Inference from large autoregressive models is slow.",
    authors: [{ name: "Yaniv Leviathan", affiliation: "Google" }],
    primaryCategory: "cs.LG",
    categories: ["cs.LG", "cs.CL"],
    publishedAt: "2022-11-30T00:00:00Z",
    updatedAt: "2023-01-10T00:00:00Z",
    doi: null,
    journalRef: null,
    comment: null,
    abstractUrl: "https://arxiv.org/abs/2211.17192v2",
    pdfUrl: "https://arxiv.org/pdf/2211.17192v2",
    ...overrides,
  };
}
