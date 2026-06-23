import Anthropic from "@anthropic-ai/sdk";
import * as pdfjsLib from "pdfjs-dist";
import busboy from "busboy";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Set PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "50mb",
    },
  },
};

async function extractFromPDF(fileBuffer) {
  const text = [];
  const images = [];

  try {
    const pdf = await pdfjsLib.getDocument({ data: fileBuffer }).promise;
    const numPages = pdf.numPages;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      
      // Extract text
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => (item.str ? item.str : ""))
        .join(" ");
      
      if (pageText.trim()) {
        text.push(`[Page ${pageNum}]\n${pageText}\n`);
      }

      // Extract images
      const operatorList = await page.getOperatorList();
      if (operatorList.fnArray && operatorList.fnArray.length > 0) {
        for (let i = 0; i < operatorList.fnArray.length; i++) {
          if (operatorList.fnArray[i] === pdfjsLib.OPS.paintImageXObject || 
              operatorList.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject) {
            
            // Found an image reference
            images.push({
              pageNum,
              index: images.length,
              placeholder: `[Image ${images.length + 1} - Page ${pageNum}]`
            });
          }
        }
      }
    }

    // Try to render pages as images if no inline images found
    if (images.length === 0) {
      for (let pageNum = 1; pageNum <= Math.min(numPages, 10); pageNum++) {
        try {
          const page = await pdf.getPage(pageNum);
          const viewport = page.getViewport({ scale: 2.0 });
          
          // Canvas rendering (basic)
          const canvas = await renderPageToCanvas(page, viewport);
          if (canvas) {
            const imageData = canvas.toDataURL('image/png');
            images.push({
              pageNum,
              index: images.length,
              placeholder: `[Image ${images.length + 1} - Page ${pageNum}]`,
              data: imageData
            });
          }
        } catch (e) {
          // Skip pages that can't be rendered
        }
      }
    }
  } catch (error) {
    console.error("PDF extraction error:", error);
  }

  return { text: text.join("\n"), images };
}

async function renderPageToCanvas(page, viewport) {
  try {
    // Return null - canvas rendering on server is complex
    // Images will be noted in text with placeholders
    return null;
  } catch (e) {
    return null;
  }
}

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
    let lectureText = "";
    let imagePlaceholders = [];
    let fileName = "";

    // Parse multipart form data
    const bb = busboy({ headers: req.headers });
    let fileBuffer = Buffer.alloc(0);
    let fileType = "";
    const fields = {};

    await new Promise((resolve, reject) => {
      bb.on("file", (fieldname, file, info) => {
        fileName = info.filename;
        fileType = info.mimeType;
        let chunks = [];

        file.on("data", (data) => {
          chunks.push(data);
        });

        file.on("end", () => {
          fileBuffer = Buffer.concat(chunks);
        });
      });

      bb.on("field", (fieldname, val) => {
        fields[fieldname] = val;
      });

      bb.on("close", resolve);
      bb.on("error", reject);

      req.pipe(bb);
    });

    // Use pasted text if provided
    if (fields.lectureText && fields.lectureText.trim()) {
      lectureText = fields.lectureText.trim();
    }

    // Extract from PDF if uploaded
    if (fileBuffer.length > 0 && fileType.includes("pdf")) {
      try {
        const { text: pdfText, images } = await extractFromPDF(fileBuffer);
        
        // Prepend PDF text if no pasted text
        if (!lectureText) {
          lectureText = pdfText;
        } else {
          // Append PDF text if both exist
          lectureText = lectureText + "\n\n" + pdfText;
        }

        imagePlaceholders = images;
      } catch (error) {
        console.error("PDF processing error:", error);
        return res.status(400).json({
          error: "Could not process PDF file. Please try again or paste text directly."
        });
      }
    }

    // Validate content
    if (!lectureText || lectureText.trim().length < 50) {
      return res.status(400).json({
        error: "Content too short. Please upload a PDF or paste more detailed lecture notes (at least 50 characters)."
      });
    }

    // Build prompt with image placeholders
    let contentWithImages = lectureText;
    if (imagePlaceholders.length > 0) {
      contentWithImages += "\n\n[IMAGES IN SOURCE MATERIAL]:\n";
      imagePlaceholders.forEach((img, idx) => {
        contentWithImages += `${img.placeholder}\n`;
      });
    }

    // Send to Claude with your specific prompt
    const systemPrompt = `You are an expert medical editor and educational content formatter.

Your task is to transform lecture slides, PDFs, PowerPoints, notes, or study materials into a standardized, highly organized medical study document.

CRITICAL RULES:

1. CONTENT PRESERVATION
* Use ONLY information found in the source material.
* Do NOT add information from your own medical knowledge.
* Do NOT remove any medically relevant information.
* Do NOT summarize unless the source itself is repetitive.
* Preserve all facts, definitions, mechanisms, causes, clinical features, investigations, complications, treatments, classifications, and examples.

2. CLARITY REWRITING
* Rewrite incomplete slide fragments into clear, grammatically correct sentences.
* If a statement is obviously abbreviated or poorly written, rewrite it so its meaning becomes clear.
* Preserve the original meaning exactly.
* Never invent missing facts.

3. ORGANIZATION
Reorganize the material into this consistent hierarchy (only include sections that exist in source):
- Main Topic
- Subtopic
- Overview
- Definition
- Etiology
- Pathogenesis
- Classification
- Causes
- Risk Factors
- Clinical Manifestations
- Morphology
- Gross Findings
- Microscopic Findings
- Complications
- Investigations
- Management
- Prognosis
- Key Definitions
- High-Yield Notes
- Summary Tables

4. TABLE CONVERSION
Whenever information compares entities, convert it into a clean markdown table format.
Examples: Acute vs Chronic, Left vs Right, Disease A vs Disease B, Causes vs Features
Use tables whenever they improve understanding.

5. IMAGE HANDLING
* If source material contains images, preserve references to them in brackets: [Image 1], [Image 2], etc.
* Place image references immediately below or beside the relevant section they relate to.
* Do NOT remove or ignore image references.

6. HIGH-YIELD ENHANCEMENTS
Create special sections when applicable (do NOT introduce new information):
- **Key Definition** - For important definitions
- **Quick Summary** - For highly testable concepts  
- **Comparison Table** - For commonly confused topics
- **Exam Pearl** - For explicitly stated high-yield facts

7. FORMATTING STYLE
* Use concise bullet points
* Avoid long paragraphs whenever possible
* Use consistent heading levels (# ## ###)
* Use **bold** for important terms on first mention
* Use tables for structured information
* Use logical spacing
* Make the document look like a polished medical review sheet

8. MULTI-SLIDE INTEGRATION
If information is spread across multiple slides:
* Merge it into one coherent section
* Remove unnecessary repetition
* Keep every unique fact

9. MCQ GENERATION
After the lecture content is completed, create a section called "## MCQ Practice"
Generate high-quality board-style questions ONLY from information explicitly present in the source material.
For each question include:
Q[number]. [Question text]
A) [Option A]
B) [Option B]
C) [Option C]  
D) [Option D]

**Answer:** [Letter] - [Explanation using only source material]

Generate at least 5-10 questions covering all major concepts.

10. FINAL QUALITY CHECK
Before finishing:
* Verify that no source information was lost
* Verify that no external information was added
* Verify that the final output is easier to study than the original lecture
* Verify that terminology remains medically accurate

Output the result as a professional, publication-quality study note with consistent formatting throughout.`;

    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 8000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Please format and organize this lecture material according to the rules specified:\n\n${contentWithImages}`,
        },
      ],
    });

    const rewrittenText = message.content[0].text;

    return res.status(200).json({
      success: true,
      content: rewrittenText,
      images: imagePlaceholders,
      fileName: fileName || "Converted Lecture",
    });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({
      error: error.message || "Server error processing your request",
    });
  }
}
