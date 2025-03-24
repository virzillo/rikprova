import { Form, useActionData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Select,
  DropZone,
  Button,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Assumo che tu abbia un file di autenticazione

export const action: ActionFunction = async ({ request }) => {
  const { admin } = await authenticate.admin(request); // Autenticazione Shopify
  const formData = await request.formData();
  const file = formData.get("file") as File;
  const tag = formData.get("tag") as string;
  const status = formData.get("status") as string;

  if (!file || !(file instanceof File)) {
    return json({ error: "Nessun file caricato o file non valido" }, { status: 400 });
  }

  // Leggi il contenuto del file
  const fileContent = await file.text();
  const eanList = fileContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const eanJson = JSON.stringify(eanList);

  // Recupera i prodotti dal negozio Shopify tramite API GraphQL
  const response = await admin.graphql(`
    query {
      products(first: 250) {
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

  const { data } = await response.json();
  const products = data.products.edges.map((edge: any) => edge.node);

  // Confronta gli EAN e aggiorna i prodotti
  for (const product of products) {
    const variants = product.variants.edges.map((edge: any) => edge.node);
    for (const variant of variants) {
      if (eanList.includes(variant.barcode)) {
        // Aggiungi il tag se non è già presente
        const updatedTags = product.tags.includes(tag)
          ? product.tags
          : [...product.tags, tag];

        // Aggiorna il prodotto con il nuovo tag e stato
        await admin.graphql(`
          mutation updateProduct($input: ProductInput!) {
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
              status: status.toUpperCase(), // Shopify richiede ACTIVE, DRAFT o ARCHIVED
            },
          },
        });
      }
    }
  }

  return json({
    message: "File elaborato e prodotti aggiornati con successo!",
    eanJson,
    eanList,
    tag,
    status,
  });
};

export default function Settings() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
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
    { label: "Active", value: "active" },
    { label: "Draft", value: "draft" },
    { label: "Archived", value: "archived" },
  ];

  return (
    <Page title="Settings">
      <Card>
        <Form method="post" encType="multipart/form-data">
          <FormLayout>
            <DropZone onDrop={handleFileDrop} accept=".txt" allowMultiple={false}>
              <DropZone.FileUpload />
            </DropZone>
            {file && <p>File selezionato: {file.name}</p>}
            {file && (
              <input
                type="file"
                name="file"
                hidden
                ref={(input) => {
                  if (input && file) {
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(file);
                    input.files = dataTransfer.files;
                  }
                }}
              />
            )}

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
              submit
              variant="primary"
              loading={navigation.state === "submitting"}
            >
              Save
            </Button>

            {actionData?.error && <p style={{ color: "red" }}>{actionData.error}</p>}
            {actionData?.message && <p>{actionData.message}</p>}
            {actionData?.tag && (
              <div>
                <h3>Tag salvato:</h3>
                <p>{actionData.tag}</p>
              </div>
            )}
            {actionData?.status && (
              <div>
                <h3>Stato salvato:</h3>
                <p>{actionData.status}</p>
              </div>
            )}
            {actionData?.eanJson && (
              <div>
                <h3>EAN in formato JSON:</h3>
                <pre>{actionData.eanJson}</pre>
              </div>
            )}
            {actionData?.eanList && (
              <div>
                <h3>Lista EAN (array):</h3>
                <pre>{JSON.stringify(actionData.eanList, null, 2)}</pre>
              </div>
            )}
          </FormLayout>
        </Form>
      </Card>
    </Page>
  );
}
