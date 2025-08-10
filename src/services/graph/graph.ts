import { ChatOpenAI, ChatOpenAICallOptions } from "@langchain/openai";
import { Annotation, StateGraph } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { retrieveTool, webSearchTool, augmentToolNode } from "./graphTools";
import { augmentationSystemPrompt, createTaskSummaryPrompt, generateAdPrompt } from "@/system_prompts/system_prompts";
import { toolsCondition } from "@langchain/langgraph/prebuilt";
import { extractStringContent, handleModelError, toBaseMessageForAugmentation, toBaseMessagesForAdGeneration, toBaseMessagesForSummary } from "@/utils/utils";
import { Message } from "@/models/message.model";
import type { BaseMessage } from "@langchain/core/messages";
import { LargeLanguageModel } from "@/models/largeLanguageModel.model";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GraphStep } from "@/enums/graphStep.enum";
import { StepStreamData } from "@/models/stepStreamData.model";
import { CustomFunction } from "@/enums/customFunction.enum";
import { useSettingsStore } from "@/store/settingsStore";
import { checkRateLimit } from "../rateLimitCheck";
import { z } from "zod";
import axios from "axios";

const retrievalOrchestrator = new ChatOpenAI({
  model: "gpt-4.1",
  temperature: 0.0,
  topP: 1.0,
  maxTokens: 200
})

const generateAdSchema = z.object({
  adText: z.string().describe("Sukurto reklamos teksto turinys. Arba tuščia '' eilutė."),
  otherText: z.string().describe("Bet koks kitas tekstas, kuris nėra reklamos turinys. Arba tuščia '' eilutė."),
});

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  filteredLinkAfterSearch: Annotation<string[]>(),
  extractedLinksFromHomePage: Annotation<string[]>(),
  filteredLinkAfterHomePage: Annotation<string[]>(),
  linksUsedForScraping: Annotation<string[]>(),
  scrapedServiceContent: Annotation<string>(),
  scrapedServices: Annotation<string>(),
  branch: Annotation<string>(),
});

async function queryOrRespond(
  state: typeof StateAnnotation.State
): Promise<{ messages: AIMessage[] }> {
  try {
    console.log('queryOrRespond started');
    const retrievalWithTools = retrievalOrchestrator.bindTools([retrieveTool, webSearchTool]);
    const retrievalPrompt = [
      new SystemMessage(augmentationSystemPrompt),
      ...state.messages,
    ];
    const response = await retrievalWithTools.invoke(retrievalPrompt);
    console.log('queryOrRespond completed');
    return { messages: [response] };
  } catch (error) {
    const errorMessage = handleModelError(error, CustomFunction.QueryOrRespond);
    return { messages: [errorMessage] };
  }
}

async function followUpWebSearch(
  state: typeof StateAnnotation.State
): Promise<{ messages: AIMessage[] }> {
  try {
    const isProduction = process.env.NODE_ENV === "production";
    const backendUrl = isProduction
      ? process.env.SEARCH_SERVICE_URL || "http://34.88.74.163:8080/"
      : "http://localhost:8080/";

    const response = await axios.post(backendUrl, { state });
    console.log('followUpWebSearch completed:');
    return response.data.lastStep
  } catch (error) {
    console.log('Error in followUpWebSearch:', error);
    const errorMessage = handleModelError(error, CustomFunction.ScrapedServiceContent);
    return { messages: [errorMessage] };
  }
}

function buildAugmentationGraph() {
  const graph = new StateGraph(StateAnnotation)
    .addNode("queryOrRespond", (state) => queryOrRespond(state))
    .addNode("tools", augmentToolNode)
    .addNode("followUpWebSearch", (state) => followUpWebSearch(state))
  graph
    .addEdge("__start__", "queryOrRespond")
    .addConditionalEdges('queryOrRespond', toolsCondition,
      {
        __end__: "__end__",
        tools: "tools"
      })
    .addEdge("tools", "followUpWebSearch")
    .addEdge("followUpWebSearch", "__end__")
  return graph.compile();
}

async function runAugmentationWorkflow(
  messages: Message[],
  onStep: (step: StepStreamData) => void
): Promise<{ terminateFurtherActions: boolean, lastStep?: typeof StateAnnotation.State }> {
  const augmentationGraph = buildAugmentationGraph();
  const langchainMessagesForAugmentation = toBaseMessageForAugmentation(messages);

  let retrievalContent: string = '';
  let scrapedServiceContent: string = ''
  let scrapedServices: string = ''

  const rateLimitResponse = await checkRateLimit();

  try {
    if (rateLimitResponse) {
      onStep({ type: GraphStep.Error, content: rateLimitResponse.generatedContent });
      return { terminateFurtherActions: true };
    }

    const steps = [];

    for await (const step of await augmentationGraph.stream({ messages: langchainMessagesForAugmentation }, { streamMode: "values" })) {
      steps.push(step);

      const retrieveMessage = step.messages?.find((message) => message.name === "retrieve");
      const errorMessage = step.messages?.find(message => message.additional_kwargs?.error === true);

      if (errorMessage) {
        onStep({ type: GraphStep.Error, content: extractStringContent(errorMessage.content) });
        return { terminateFurtherActions: true };
      }

      if (!retrievalContent && retrieveMessage) {
        retrievalContent = extractStringContent(retrieveMessage.content);
        onStep({ type: GraphStep.RetrievalContent, content: retrievalContent });
      }

      if (!scrapedServiceContent && step.scrapedServiceContent) {
        scrapedServiceContent = step.scrapedServiceContent;
        onStep({ type: GraphStep.ScrapedServiceContent, content: scrapedServiceContent });
      }

      if (!scrapedServices && step.scrapedServices) {
        scrapedServices = step.scrapedServices;
        onStep({ type: GraphStep.ScrapedServices, content: scrapedServices });
      }
    }
    const lastStep = steps[steps.length - 1];
    return {
      terminateFurtherActions: false,
      lastStep
    };
  } catch (error) {
    console.error("❌ Error in runAugmentationWorkflow:", error);
    onStep({ type: GraphStep.Error, content: `❌ Augmentation error: ${String(error)}\n\n` });
    return { terminateFurtherActions: true };
  }
}

function getModelInstance(
  modelName: LargeLanguageModel,
  temperature: number,
  topP: number
): ChatAnthropic | ChatGoogleGenerativeAI | ChatOpenAI<ChatOpenAICallOptions> {
  const modelMap = {
    openai: new ChatOpenAI({
      model: "gpt-4o-mini",
      temperature,
      topP,
      maxTokens: 1500,
    }),
    gemini: new ChatGoogleGenerativeAI({
      model: "gemini-2.0-flash",
      temperature,
      topP,
      maxOutputTokens: 1500,
    }),
    anthropic: new ChatAnthropic({
      model: "claude-3-5-sonnet-20240620",
      temperature,
      topP,
      maxTokens: 1500,
    }),
  };

  const llmInstance = modelMap[modelName];
  if (!llmInstance) {
    throw new Error(`Unknown model: ${modelName}`);
  }
  return llmInstance;
}

async function createTaskSummary(state: typeof StateAnnotation.State, modelName: LargeLanguageModel): Promise<{ messages: AIMessage[] }> {
  console.log(`---createTaskSummary started for model ${modelName}`);
  try {
    const llmInstance = getModelInstance(modelName, 0.1, 0.9);
    const retrievalToolMessage = state.messages?.find((message) => message.name === "retrieve");
    const humanMessageList = state.messages?.filter((message) => message instanceof HumanMessage);
    const lastHumanMessage = humanMessageList ? humanMessageList[humanMessageList.length - 1] : undefined;

    const retrievedContext = retrievalToolMessage ? extractStringContent(retrievalToolMessage.content) : '';
    const initialUserPrompt = lastHumanMessage ? extractStringContent(lastHumanMessage.content) : '';

    const scrapedServiceContentMessage = state.messages?.find(message => message instanceof AIMessage && message.additional_kwargs?.custom_function === CustomFunction.ScrapedServiceContent);
    const scrapedServiceContent = scrapedServiceContentMessage ? extractStringContent(scrapedServiceContentMessage.content) : '';

    const scrapedServicesMessage = state.messages?.find(message => message instanceof AIMessage && message.additional_kwargs?.custom_function === CustomFunction.ScrapedServices);
    const scrapedServices = scrapedServicesMessage ? extractStringContent(scrapedServicesMessage.content) : '';

    const prompt = [
      scrapedServices ?
        new SystemMessage(createTaskSummaryPrompt(initialUserPrompt, undefined, scrapedServices, retrievedContext)) :
        new SystemMessage(createTaskSummaryPrompt(initialUserPrompt, scrapedServiceContent, undefined, retrievedContext)),
      new HumanMessage("Prašau sukurti apibendrintą užduotį reklamos sukūrimui pagal pateiktą informaciją."),
    ];

    const response = await llmInstance.invoke(prompt);
    response.additional_kwargs = {
      ...response.additional_kwargs,
      custom_model_name: modelName,
      custom_function: CustomFunction.CreateTaskSummary,
    }
    return { messages: [response] };
  } catch (error) {
    const errorMessage = handleModelError(error, CustomFunction.CreateTaskSummary, modelName);
    return { messages: [errorMessage] };
  }
}

async function generateAd(state: typeof StateAnnotation.State, modelName: LargeLanguageModel): Promise<{ messages: AIMessage[] }> {
  console.log(`---generateAd started for model ${modelName}`);
  try {
    const temperature = useSettingsStore.getState().temperature;
    const topP = useSettingsStore.getState().topP;
    const llmInstance = getModelInstance(modelName, temperature, topP);
    const aiMessages = state.messages.filter(message => message instanceof AIMessage);
    const filteredModelMessage = aiMessages.find(message => {
      return message.additional_kwargs?.custom_model_name === modelName && message.additional_kwargs?.custom_function === CustomFunction.CreateTaskSummary;
    });
    const taskSummary = filteredModelMessage ? extractStringContent(filteredModelMessage.content) : '';

    const conversationMessages = state.messages.filter(
      (message) =>
        message instanceof HumanMessage ||
        message instanceof SystemMessage ||
        (message instanceof AIMessage &&
          message.additional_kwargs?.custom_function !== CustomFunction.CreateTaskSummary &&
          message.additional_kwargs?.custom_function !== CustomFunction.ScrapedServiceContent &&
          message.additional_kwargs?.custom_function !== CustomFunction.ScrapedServices &&
          !extractStringContent(message.content).includes("Failed to generate"))
    );
    const prompt = [
      new SystemMessage(generateAdPrompt(taskSummary)),
      ...conversationMessages
    ];

    const llmWithSchema = llmInstance.withStructuredOutput(generateAdSchema);
    const structuredResponse = await llmWithSchema.invoke(prompt);

    const response = new AIMessage({
      content: JSON.stringify(structuredResponse),
      additional_kwargs: {
        custom_model_name: modelName,
        custom_function: CustomFunction.GenerateAdContent,
      }
    });

    return { messages: [response] };
  } catch (error) {
    const errorMessage = handleModelError(error, CustomFunction.GenerateAdContent, modelName);
    return { messages: [errorMessage] };
  }
}

function buildCreationGraph(model: LargeLanguageModel, shouldRunTaskSummary: boolean) {
  const graph = new StateGraph(StateAnnotation);

  const modelId = model.toString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskSummaryNodeName: any = `createTaskSummary_${modelId}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generateAdNodeName: any = `generateAd_${modelId}`;
  if (shouldRunTaskSummary) {
    graph
      .addNode(taskSummaryNodeName, (state) => createTaskSummary(state, model))
      .addNode(generateAdNodeName, (state) => generateAd(state, model))
      .addEdge("__start__", taskSummaryNodeName)
      .addEdge(taskSummaryNodeName, generateAdNodeName)
      .addEdge(generateAdNodeName, "__end__");
  } else {
    graph
      .addNode(generateAdNodeName, (state) => generateAd(state, model))
      .addEdge("__start__", generateAdNodeName)
      .addEdge(generateAdNodeName, "__end__");
  }

  return graph.compile();
}

function processStepMessages(
  step: typeof StateAnnotation.State,
  modelName: LargeLanguageModel,
  summaries: Record<string, string>,
  generatedAds: Record<string, string>,
  onStep: (step: StepStreamData) => void
): void {
  const errorMessage = step.messages?.find(message =>
    message.additional_kwargs?.custom_model_name === modelName &&
    message.additional_kwargs?.error === true
  );

  if (errorMessage) {
    onStep({
      type: GraphStep.Error,
      content: extractStringContent(errorMessage.content),
      model: modelName
    });
    return;
  }

  const summaryMessage = step.messages?.find(message =>
    message.additional_kwargs?.custom_model_name === modelName &&
    message.additional_kwargs?.custom_function === CustomFunction.CreateTaskSummary &&
    !message.additional_kwargs?.historical
  );

  if (!summaries[modelName] && summaryMessage) {
    summaries[modelName] = extractStringContent(summaryMessage.content);
    onStep({
      type: GraphStep.TaskSummary,
      content: summaries[modelName],
      model: modelName
    });
  }

  const generatedAdMessages = step.messages?.filter(message =>
    message.additional_kwargs?.custom_model_name === modelName &&
    message.additional_kwargs?.custom_function === CustomFunction.GenerateAdContent &&
    !message.additional_kwargs?.historical
  );

  const lastGeneratedAdMessage = generatedAdMessages?.length > 0 ?
    generatedAdMessages[generatedAdMessages.length - 1] :
    undefined;

  if (!generatedAds[modelName] && lastGeneratedAdMessage) {
    generatedAds[modelName] = extractStringContent(lastGeneratedAdMessage.content);
    onStep({
      type: GraphStep.GenerateAd,
      content: generatedAds[modelName],
      model: modelName
    });
  }
}

async function runCreationWorkflow(
  state: typeof StateAnnotation.State,
  frontendMessages: Message[],
  models: LargeLanguageModel[],
  onStep: (step: StepStreamData) => void,
  shouldRunTaskSummary: boolean = false,
): Promise<void> {
  const summaries: Record<string, string> = {};
  const generatedAds: Record<string, string> = {};

  await Promise.allSettled(
    models.map(async (model) => {
      const creationGraph = buildCreationGraph(model, shouldRunTaskSummary);
      const frontendBaseMessages = toBaseMessagesForAdGeneration(frontendMessages, model);

      const aiMessagesFromAugmentation = toBaseMessagesForSummary(state)
      const combinedMessages = [
        ...frontendBaseMessages,
        ...aiMessagesFromAugmentation
      ];

      try {
        for await (const step of await creationGraph.stream({ messages: combinedMessages }, { streamMode: "values" })) {
          processStepMessages(
            step,
            model,
            summaries,
            generatedAds,
            onStep
          );
        }
      } catch (error) {
        console.error(`❌ Error in runCreationWorkflow for model ${model}:`, error);
        onStep({
          type: GraphStep.Error,
          content: `❌ Creation error for ${model}: ${String(error)}\n\n`,
          model: model
        });
      }
    })
  );
}

export async function runWorkflow(
  messages: Message[],
  models: LargeLanguageModel[],
  onStep: (step: StepStreamData) => void
): Promise<void> {

  const response = await runAugmentationWorkflow(messages, onStep);
  if (!response.lastStep || response.terminateFurtherActions) {
    console.log("❌ runWorkflow - Augmentation workflow terminated early.");
    return
  }

  const shouldRunTaskSummary = !!response.lastStep.scrapedServiceContent ||
    !!response.lastStep.scrapedServices ||
    !!response.lastStep.messages.some(msg => (msg instanceof ToolMessage && msg.name === "retrieve"))

  await runCreationWorkflow(response.lastStep, messages, models, onStep, shouldRunTaskSummary);
}
