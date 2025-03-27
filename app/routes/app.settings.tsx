import { Form, useActionData, useSubmit } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Select,
  DropZone,
  Button,
  Banner
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Utility function for delay
async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry mechanism with exponential backoff
async function retryWithBackoff(fn: () => Promise<any>, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error && error.message.includes('Throttled')) {
        const waitTime = Math.pow(2, retries) * 1000; // Exponential backoff
        console.log(`Throttled. Waiting ${waitTime}ms before retry.`);
        await delay(waitTime);
        retries++;
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries exceeded');
}

export const action: ActionFunction = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const file = formData.get("file") as File;
  const tag = formData.get("tag") as string;
  const status = formData.get("status") as string;

  if (!file || !(file instanceof File)) {
    return json({ error: "Nessun file caricato o file non valido" }, { status: 400 });
  }

  const fileContent = await file.text();
  const eanList = fileContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let hasNextPage = true;
  let cursor = null;
  const updatedProducts = [];
  const batchSize = 50; // Reduce batch size to minimize throttling

  type GraphQLResponse = {
    data: {
      products: {
        pageInfo: {
          endCursor: string;
          hasNextPage: boolean;
        };
        edges: {
          node: {
            id: string;
            variants: {
              edges: {
                node: {
                  barcode: string;
                };
              }[];
            };
            tags: string[];
            status: string;
          };
        }[];
      };
    };
  };

  while (hasNextPage) {
    const searchString = cursor 
      ? `first: ${batchSize}, after: "${cursor}"` 
      : `first: ${batchSize}`;

    const response = await retryWithBackoff(async () => {
      return await admin.graphql(`
        query {
          products(${searchString}) {
            pageInfo {
              endCursor
              hasNextPage
            }
            edges {
              node {
                id
                variants(first: 100) {
                  edges {
                    node {
                      barcode
                    }
                  }
                }
                tags
                status
              }
            }
          }
        }
      `);
    });
  
    const responseData = (await response.json()) as GraphQLResponse;
    const products = responseData.data.products.edges.map((edge) => edge.node);

    for (const product of products) {
      try {
        const variants = product.variants.edges.map((edge) => edge.node);
        const matchingVariant = variants.find((variant) => 
          eanList.includes(variant.barcode)
        );

        if (matchingVariant) {
          const updatedTags = product.tags.includes(tag)
            ? product.tags
            : [...product.tags, tag];

          const updateResponse = await retryWithBackoff(async () => {
            return await admin.graphql(`
              mutation productUpdate($input: ProductInput!) {
                productUpdate(input: $input) {
                  product {
                    id
                    tags
                    status
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `, {
              variables: {
                input: {
                  id: product.id,
                  tags: updatedTags,
                  status: status.toUpperCase(),
                },
              },
            });
          });

          const updateResult = await updateResponse.json();
          
          if (updateResult.data?.productUpdate?.userErrors?.length > 0) {
            console.error('Update errors:', updateResult.data.productUpdate.userErrors);
          } else {
            updatedProducts.push({
              id: product.id,
              barcode: matchingVariant.barcode,
              tags: updatedTags
            });
          }

          // Add a small delay between updates
          await delay(200);
        }
      } catch (error) {
        console.error(`Error updating product ${product.id}:`, error);
      }
    }

    hasNextPage = responseData.data.products.pageInfo.hasNextPage;
    cursor = responseData.data.products.pageInfo.endCursor;

    if (!hasNextPage) break;

    // Add a delay between pagination requests
    await delay(500);
  }

  return json({
    success: true,
    message: "File elaborato e prodotti aggiornati con successo!",
    updatedProductsCount: updatedProducts.length,
  });
};

export default function Settings() {
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [tagValue, setTagValue] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("active");
  const [file, setFile] = useState<File | null>(null);

  const handleTagChange = useCallback((value: string) => setTagValue(value), []);
  const handleStatusChange = useCallback(
    (value: string) => setSelectedStatus(value),
    []
  );
  const handleFileDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[]) => {
      setFile(acceptedFiles[0]);
    },
    []
  );

  const statusOptions = [
    { label: "Attivo", value: "active" },
    { label: "Bozza", value: "draft" },
    { label: "Archiviato", value: "archived" },
  ];

  const handleSubmit = () => {
    if (file) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("tag", tagValue);
      formData.append("status", selectedStatus);
      submit(formData, { method: "post", encType: "multipart/form-data" });
    }
  };

  return (
    <Page title="Trova Prodotti Fuori Produzione">
      <Card>
        <FormLayout>
          <text>
            Inserisci file .txt
          </text>
          <DropZone onDrop={handleFileDrop} accept=".txt" allowMultiple={false}>
            <DropZone.FileUpload />
          </DropZone>
          {file && <p>File selezionato: {file.name}</p>}

          <TextField
            label="Tag"
            name="tag"
            value={tagValue}
            onChange={handleTagChange}
            autoComplete="off"
          />

          <Select
            label="Status"
            name="status"
            options={statusOptions}
            value={selectedStatus}
            onChange={handleStatusChange}
          />

          <Button
            variant="primary"
            onClick={handleSubmit}
          >
            Save
          </Button>
        </FormLayout>
      </Card>

      {actionData?.success && (
        <div style={{ marginTop: '20px' }}>
          <Banner
            title="Aggiornamento Prodotti"
          >
            <p>{actionData.message}</p>
            <p>Numero di prodotti aggiornati: {actionData.updatedProductsCount}</p>
          </Banner>
        </div>
      )}
    </Page>
  );
}