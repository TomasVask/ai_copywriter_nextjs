import { z } from "zod";
import { vectorStore } from "../knowledgeBase";
import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import axios from "axios";

const retrieveSchema = z.object({
  query: z.string(),
  company: z.string()
});

const webSearchSchema = z.object({
  query: z.string()
});

const KNOWN_COMPANIES = [
  "Denticija",
  "Era Dental",
  "Evadenta",
  "Geros buhalterės",
  "ID Clinic",
  "Orto Vita",
  "Pabridentas",
  "Savi",
  "Vingio klinika"
];

interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export const retrieveTool = tool(
  async ({ query, company }) => {
    console.log('RETRIEVE started')
    const foundCompany = KNOWN_COMPANIES.find(name =>
      company.toLowerCase().includes(name.toLowerCase())
    );
    const companyFilter = foundCompany ? { company: foundCompany } : undefined;
    const retrievedDocs = await vectorStore.similaritySearch(query, 4, companyFilter);

    // Filter out duplicates by pageContent (or use another unique property if needed)
    const uniqueDocs = [];
    const seenContents = new Set<string>();
    for (const doc of retrievedDocs) {
      if (!seenContents.has(doc.pageContent)) {
        uniqueDocs.push(doc);
        seenContents.add(doc.pageContent);
      }
      if (uniqueDocs.length >= 4) break;
    }

    const serialized = uniqueDocs
      .map((doc, index) => `
    Reklama: ${index + 1}
    Turinys: ${doc.pageContent}
    Įmonė: ${doc.metadata.company}
    `).join("\n");

    console.log('RETRIEVE completed')
    return [serialized, uniqueDocs];
  },
  {
    name: "retrieve",
    description: "Surink informaciją, susijusią su užklausa.",
    schema: retrieveSchema,
    responseFormat: "content_and_artifact",
  }
);

export const webSearchTool = tool(
  async ({ query }) => {
    console.log('WEB_SEARCH started')
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return { error: "Query is missing or empty" };
    }
    const params = {
      q: query,
      location: "Lithuania",
      hl: "lt",
      gl: "lt",
      apiKey: process.env.SERPER_API_KEY
    };

    try {
      const response = await axios.get("https://google.serper.dev/search", { params });
      if (!response.data || !response.data.organic) {
        return { error: "No search results found" };
      }
      const searchedLinks: string[] = response.data.organic.map((result: WebSearchResult) => result.link);
      console.log('WEB_SEARCH completed')
      return searchedLinks;
    } catch (err) {
      console.error("Serper error:", err);
      return { error: "Web search failed" };
    }
  },
  {
    name: "web_search",
    description: "Ieškok aktualios informacijos internete.",
    schema: webSearchSchema,
    responseFormat: "content"
  }
);

export const augmentToolNode = new ToolNode([retrieveTool, webSearchTool]);