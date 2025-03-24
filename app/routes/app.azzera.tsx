import { Form, useActionData, useSubmit } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  Button,
  Banner,
  Select,
  ButtonGroup
} from "@shopify/polaris";
import { useState } from "react";
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import cron from "node-cron";

export const action: ActionFunction = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action") as string;

  // Funzione di aggiornamento prodotti
  async function updateProductsWithNoInventory() {
    const pageSize = 250;
    let hasNextPage = true;
    let cursor = null;
    const updatedProducts = [];

    while (hasNextPage) {
      const searchString = cursor 
        ? `first: ${pageSize}, after: "${cursor}"` 
        : `first: ${pageSize}`;

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
                      inventoryQuantity
                    }
                  }
                }
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
                      inventoryQuantity: number;
                    };
                  }[];
                };
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
          const allVariantsOutOfStock = variants.every((variant: any) => variant.inventoryQuantity === 0);

          if (allVariantsOutOfStock && product.status !== 'DRAFT') {
            const updateResponse = await admin.graphql(`
              mutation productUpdate($input: ProductInput!) {
                productUpdate(input: $input) {
                  product {
                    id
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
                  status: 'DRAFT',
                },
              },
            });

            const updateResult = await updateResponse.json();
            
            if (updateResult.data?.productUpdate?.userErrors?.length > 0) {
              console.error('Update errors:', updateResult.data.productUpdate.userErrors);
            } else {
              updatedProducts.push({
                id: product.id,
                status: 'DRAFT'
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

    return {
      success: true,
      message: "Prodotti aggiornati con successo!",
      updatedProductsCount: updatedProducts.length,
    };
  }

  // Gestione delle diverse azioni
  if (action === "scheduleCron") {
    const every = formData.get("every") as string;
    const period = formData.get("period") as string;
    
    let cronExpression = "";
    switch (period) {
      case "minutes":
        cronExpression = `${every} * * * * *`;
        break;
      case "hours":
        cronExpression = `0 */${every} * * * *`;
        break;
      case "days":
        cronExpression = `0 0 */${every} * * *`;
        break;
      default:
        return json({ 
          success: false, 
          error: "Periodo non valido" 
        }, { status: 400 });
    }

    // Schedula il job
    const scheduledJob = cron.schedule(cronExpression, async () => {
      try {
        await updateProductsWithNoInventory();
        console.log(`Cron job eseguito alle ${new Date().toLocaleString()}`);
      } catch (error) {
        console.error("Errore nell'esecuzione del cron job:", error);
      }
    });

    return json({ 
      success: true, 
      message: `Job schedulato: ogni ${every} ${period}` 
    });
  }

  // Esecuzione manuale
  if (action === "runNow") {
    const result = await updateProductsWithNoInventory();
    return json(result);
  }

  // Caso di default
  return json({ 
    success: false, 
    error: "Azione non riconosciuta" 
  }, { status: 400 });
};

export default function AppAzzera() {
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [every, setEvery] = useState("1");
  const [period, setPeriod] = useState("minutes");

  const everyOptions = [
    { label: "1", value: "1" },
    { label: "5", value: "5" },
    { label: "10", value: "10" },
    { label: "15", value: "15" },
    { label: "30", value: "30" },
    { label: "60", value: "60" }
  ];

  const periodOptions = [
    { label: "Minuti", value: "minutes" },
    { label: "Ore", value: "hours" },
    { label: "Giorni", value: "days" }
  ];

  const handleUpdateProducts = () => {
    const formData = new FormData();
    formData.append("action", "runNow");
    submit(formData, { method: "post" });
  };

  const handleScheduleCron = () => {
    const formData = new FormData();
    formData.append("every", every);
    formData.append("period", period);
    formData.append("action", "scheduleCron");
    submit(formData, { method: "post" });
  };

  return (
    <Page title="Aggiorna Prodotti">
      <Card>
        <FormLayout>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <Select
                label="Ogni"
                options={everyOptions}
                value={every}
                onChange={(value) => setEvery(value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Select
                label="Periodo"
                options={periodOptions}
                value={period}
                onChange={(value) => setPeriod(value)}
              />
            </div>
          </div>

          <ButtonGroup>
            <Button 
              variant="primary" 
              onClick={handleUpdateProducts}
            >
              Aggiorna Prodotti
            </Button>
            <Button 
              variant="secondary" 
              onClick={handleScheduleCron}
            >
              Schedula Job
            </Button>
          </ButtonGroup>
        </FormLayout>
      </Card>

      {actionData?.success && (
  <div style={{ marginTop: '20px' }}>
    <Banner
      title="Aggiornamento Prodotti"
    >
      <p>{actionData.message}</p>
      <p>Prodotti aggiornati in questo momento: {actionData.updatedProductsCount}</p>
    </Banner>
  </div>
)}
      {actionData?.error && (
        <div style={{ marginTop: '20px' }}>
          <Banner
            title="Errore"
          >
            <p>{actionData.error}</p>
          </Banner>
        </div>
      )}
    </Page>
  );
}