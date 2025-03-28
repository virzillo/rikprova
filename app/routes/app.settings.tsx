import { Frame, Page, Card, FormLayout, Select, DropZone, Button, Banner } from "@shopify/polaris";
import { useState, useCallback, useEffect } from "react";
import { useActionData, useLoaderData, useSubmit, Form } from "@remix-run/react";
import type { ActionFunction, LoaderFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import * as XLSX from "xlsx";

// Loader function to fetch distinct vendor values from products' metafields ("custom.fornitore")
export const loader: LoaderFunction = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    // Query products that have the metafield "custom.fornitore"
    const productsResponse = await admin.graphql(`
      query {
        products(first: 250, query: "metafield:custom.fornitore:*") {
          edges {
            node {
              id
              metafields(namespace: "custom", first: 5) {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    `);

    // Use JSON.stringify with indentations for easier readability in logs.
    const rawData = await productsResponse.text();
    console.log("Raw products response:\n", JSON.stringify(JSON.parse(rawData), null, 2));
    
    let data;
    try {
      data = JSON.parse(rawData);
    } catch (err) {
      console.error("Error parsing products JSON", err);
      throw new Error("Parsing error for products response");
    }
    
    // Assuming each productEdges item has a node containing metafields edges.
    const productEdges: any[] = data.data.products.edges;
    const vendorSet = new Set<string>();

    // Log all metafields for every product for debugging.
    productEdges.forEach((edge: any) => {
      console.log(`Product ID ${edge.node.id} metafields:`);
      edge.node.metafields.edges.forEach((metaEdge: any) => {
        console.log(`  Key: ${metaEdge.node.key}, Value: ${metaEdge.node.value}`);
      });
    });

    // Build vendor set (using case‑insensitive matching for the key "fornitore")
    productEdges.forEach((edge: any) => {
      edge.node.metafields.edges.forEach((metaEdge: any) => {
        if (metaEdge.node.key.toLowerCase() === "fornitore" && metaEdge.node.value) {
          vendorSet.add(metaEdge.node.value.trim());
        }
      });
    });

    const vendors = Array.from(vendorSet);
    console.log("Distinct vendors extracted:\n", JSON.stringify(vendors, null, 2));
    return json({ success: true, metafields: vendors });
  } catch (error) {
    console.error("Error in loader fetching product metafields:", error);
    return json({ error: true, message: "Impossibile recuperare i metafields dei prodotti" });
  }
};

// Action function for processing the Excel file and updating products
export const action: ActionFunction = async ({ request }) => {
  console.time("ProductUpdateProcess");
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();

    // Get inputs from the form:
    const file = formData.get("file") as File;
    const selectedColumn = formData.get("column") as string;
    // The chosen vendor from the dropdown.
    const selectedMetafield = formData.get("metafield") as string;
    const tag = formData.get("tag") as string;
    const status = formData.get("status") as string;

    if (!file || file.size === 0) throw new Error("Nessun file caricato o file vuoto");
    if (!selectedColumn) throw new Error("Nessuna colonna selezionata");
    if (!selectedMetafield) throw new Error("Nessun fornitore selezionato");

    // Read Excel file contents.
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet);
    const codes = data
      .map((row: Record<string, any>) => row[selectedColumn])
      .filter((code) => code != null)
      .map((code) => String(code).trim())
      .filter((code) => code.length > 0);
    console.log("Extracted codes:\n", JSON.stringify(codes, null, 2));

    // Process products in batches by searching for barcodes.
    const MAX_PROCESSING_TIME = 290000; // ~5 minutes.
    const START_TIME = Date.now();
    const BATCH_SIZE = 250;
    let hasNextPage = true;
    let cursor: string | null = null;
    const updatedProducts: any[] = [];
    let batchCount = 0;
    const codesQueryString = codes.map((code) => `variants.barcode:${code}`).join(" OR ");

    while (hasNextPage) {
      if (Date.now() - START_TIME > MAX_PROCESSING_TIME) {
        console.log("Approaching time limit, stopping processing");
        break;
      }
      batchCount++;
      const searchString: string =
        cursor
          ? `first: ${BATCH_SIZE}, after: "${cursor}", query: "${codesQueryString}"`
          : `first: ${BATCH_SIZE}, query: "${codesQueryString}"`;

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
                metafields(namespace: "custom", first: 10) {
                  edges {
                    node {
                      key
                      value
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
      const responseData = await response.json();

      // Filter products: update only those that have the metafield "fornitore" matching the selected vendor.
      const products = responseData.data.products.edges.filter((edge: any) => {
        const matchingMetafield = edge.node.metafields.edges.find((meta: any) =>
          meta.node.key.toLowerCase() === "fornitore" && meta.node.value === selectedMetafield
        );
        const variants = edge.node.variants.edges.map((v: any) => v.node);
        const matchingVariant = variants.find((variant: any) => codes.includes(variant.barcode));
        return matchingMetafield && matchingVariant;
      });

      // For each matching product, update it.
      for (const productEdge of products) {
        const product = productEdge.node;
        try {
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
                tags: product.tags.includes(tag) ? product.tags : [...product.tags, tag],
                status: status.toUpperCase(),
              },
            },
          });
          const updateResult = await updateResponse.json();
          if (!updateResult.data?.productUpdate?.userErrors?.length) {
            updatedProducts.push({
              id: product.id,
              barcode: product.variants.edges[0].node.barcode,
            });
          }
        } catch (updateError) {
          console.error(`Error updating product ${product.id}:`, updateError);
        }
      }

      hasNextPage = responseData.data.products.pageInfo.hasNextPage;
      cursor = responseData.data.products.pageInfo.endCursor;
      if (!hasNextPage) break;
    }
    console.timeEnd("ProductUpdateProcess");

    return json({
      success: true,
      message: "File elaborato e prodotti aggiornati con successo!",
      updatedProductsCount: updatedProducts.length,
      totalCodesProcessed: codes.length,
      batchesProcessed: batchCount,
    });
  } catch (error) {
    console.error("Processing error:", error);
    return json({ error: true, message: error instanceof Error ? error.message : "Errore durante l'elaborazione" }, { status: 500 });
  }
};

export default function Settings() {
  const loaderData = useLoaderData<{ metafields: string[] }>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();

  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [selectedColumn, setSelectedColumn] = useState("");
  const [metafields, setMetafields] = useState<string[]>([]);
  const [selectedMetafield, setSelectedMetafield] = useState("");
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState("active");

  useEffect(() => {
    if (loaderData?.metafields) {
      console.log("Received vendor list from loader:\n", JSON.stringify(loaderData.metafields, null, 2));
      setMetafields(loaderData.metafields);
    }
  }, [loaderData]);

  const handleFileDrop = useCallback((files: File[]) => {
    const droppedFile = files[0];
    setFile(droppedFile);
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const headers = XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0] as string[];
      console.log("Extracted headers:\n", JSON.stringify(headers, null, 2));
      setColumns(headers);
    };
    reader.readAsArrayBuffer(droppedFile);
  }, []);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (file) {
      const formData = new FormData(event.currentTarget);
      formData.append("file", file);
      submit(formData, { method: "post", encType: "multipart/form-data" });
    }
  };

  const statusOptions = [
    { label: "Attivo", value: "active" },
    { label: "Bozza", value: "draft" },
    { label: "Archiviato", value: "archived" },
  ];

  return (
    <Frame>
      <Page title="Aggiorna Prodotti">
        <Card>
          <Form method="post" encType="multipart/form-data" onSubmit={handleSubmit}>
            <FormLayout>
              <DropZone onDrop={handleFileDrop} accept=".xlsx" allowMultiple={false}>
                <DropZone.FileUpload />
              </DropZone>
              {file && <p>File selezionato: {file.name}</p>}
              {columns.length > 0 && (
                <Select
                  label="Seleziona Colonna"
                  options={columns.map((col) => ({ label: col, value: col }))}
                  value={selectedColumn}
                  onChange={(value) => setSelectedColumn(value)}
                  name="column"
                />
              )}
              {metafields.length > 0 && (
                <Select
                  label="Seleziona Fornitore"
                  options={metafields.map((vendor) => ({ label: vendor, value: vendor }))}
                  value={selectedMetafield}
                  onChange={(value) => setSelectedMetafield(value)}
                  name="metafield"
                />
              )}
              <Select
                label="Status"
                name="status"
                options={statusOptions}
                value={status}
                onChange={(value) => setStatus(value)}
              />
              <Button
                submit
                variant="primary"
                disabled={!file || !selectedColumn || !selectedMetafield}
              >
                Aggiorna Prodotti
              </Button>
            </FormLayout>
          </Form>
        </Card>
        {actionData?.success && (
          <Banner title="Aggiornamento Completato" tone="success">
            <p>{actionData.message}</p>
            <p>Prodotti aggiornati: {actionData.updatedProductsCount}</p>
            <p>Codici processati: {actionData.totalCodesProcessed}</p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner title="Errore" tone="critical">
            <p>{actionData.message}</p>
          </Banner>
        )}
      </Page>
    </Frame>
  );
}