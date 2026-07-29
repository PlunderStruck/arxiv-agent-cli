export function atomFeed(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <id>https://export.arxiv.org/api/query</id>
  <title>arXiv Query</title>
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <entry>
    <id>https://arxiv.org/abs/2211.17192v2</id>
    <updated>2023-01-10T00:00:00Z</updated>
    <published>2022-11-30T00:00:00Z</published>
    <title>Fast Inference from Transformers</title>
    <summary>Inference from autoregressive models is slow.</summary>
    <author><name>Yaniv Leviathan</name><arxiv:affiliation>Google</arxiv:affiliation></author>
    <arxiv:primary_category term="cs.LG"/>
    <category term="cs.LG"/>
    <category term="cs.CL"/>
    <link href="https://arxiv.org/pdf/2211.17192v2" title="pdf" type="application/pdf"/>
  </entry>
</feed>`;
}
