import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { lectureText, images } = req.body;

    if (!lectureText || typeof lectureText !== "string") {
      return res.status(400).json({ error: "Invalid lecture content" });
    }

    const systemPrompt = `You are an expert medical/academic textbook author who specializes in creating clear, comprehensive educational content in the style of Pathoma (a renowned medical education resource).

When given lecture notes, you will:
1. Reorganize content into clear hierarchical sections (main concepts → subconcepts)
2. Add opening context/framework before diving into details
3. Use clinical examples and practical applications
4. Break complex ideas into digestible paragraphs
5. Add emphasis on key takeaways and clinical pearls
6. Use consistent terminology and maintain pedagogical flow
7. Create clear transitions between topics
8. Format with appropriate headers and subheaders

Output ONLY the rewritten content in markdown format. Start immediately without preamble. Use proper markdown syntax for headers (# ## ###), bold (**text**), italics (*text*), lists, etc.`;

    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Convert this lecture into a Pathoma-style textbook chapter. Preserve the core information but make it more suitable for serious academic study. Add relevant context, clinical examples, and make the presentation more formal and structured.

LECTURE CONTENT:
${lectureText}`,
        },
      ],
    });

    const textContent = message.content[0].text;

    return res.status(200).json({ 
      text: textContent,
      images: images || []
    });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
}
