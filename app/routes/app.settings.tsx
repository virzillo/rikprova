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

  while (hasNextPage) {
    const searchString = cursor 
      ? `first: 250, after: "${cursor}"` 
      : `first: 250`;

    const response = await admin.graphql(`
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

    const responseData = (await response.json()) as GraphQLResponse;
    const products = responseData.data.products.edges.map((edge: any) => edge.node);

    for (const product of products) {
      try {
        const variants = product.variants.edges.map((edge: any) => edge.node);
        const matchingVariant = variants.find((variant: any) => 
          eanList.includes(variant.barcode)
        );

        if (matchingVariant) {
          const updatedTags = product.tags.includes(tag)
            ? product.tags
            : [...product.tags, tag];

          const updateResponse = await admin.graphql(`
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
        }
      } catch (error) {
        console.error(`Error updating product ${product.id}:`, error);
      }
    }

    hasNextPage = responseData.data.products.pageInfo.hasNextPage;
    cursor = responseData.data.products.pageInfo.endCursor;

    if (!hasNextPage) break;
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