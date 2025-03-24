import { useActionData, useSubmit } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  Button,
  Banner,
  Select,
  ButtonGroup,
  TextContainer,
  Text,
  BlockStack,
  Layout,
} from "@shopify/polaris";
import { useState, useEffect } from "react";
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import cron from "node-cron";

export const action: ActionFunction = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action") as string;

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

    const scheduledJob = cron.schedule(cronExpression, async () => {
      try {
        await updateProductsWithNoInventory();
        console.log(`Cron job eseguito con successo alle ${new Date().toLocaleString()}`);
      } catch (error) {
        console.error("Errore nell'esecuzione del cron job:", error);
      }
    });

    return json({ 
      success: true, 
      message: `Job schedulato: ogni ${every} ${period}` 
    });
  }

  if (action === "runNow") {
    const result = await updateProductsWithNoInventory();
    return json(result);
  }

  return json({ 
    success: false, 
    error: "Azione non riconosciuta" 
  }, { status: 400 });
};

type ScheduledJob = {
  id: string;
  every: string;
  period: string;
  time: string;
};

export default function AppAzzera() {
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [every, setEvery] = useState("1");
  const [period, setPeriod] = useState("minutes");
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJob[]>([]);
  const [executionMessage, setExecutionMessage] = useState<string | null>(null);

  useEffect(() => {
    const storedJobs = localStorage.getItem("scheduledJobs");
    if (storedJobs) {
      setScheduledJobs(JSON.parse(storedJobs));
    }
  }, []);

  useEffect(() => {
    if (actionData?.success) {
      setExecutionMessage(actionData.message);
    }
  }, [actionData]);

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

    const newJob = {
      id: `${every}-${period}-${Date.now()}`,
      every,
      period,
      time: new Date().toLocaleString(),
    };

    const updatedJobs = [...scheduledJobs, newJob];
    setScheduledJobs(updatedJobs);

    // Save to local storage
    localStorage.setItem("scheduledJobs", JSON.stringify(updatedJobs));
  };

  const handleStopJob = (jobId: string) => {
    const updatedJobs = scheduledJobs.filter(job => job.id !== jobId);
    setScheduledJobs(updatedJobs);

    // Update local storage
    localStorage.setItem("scheduledJobs", JSON.stringify(updatedJobs));
  };

  const handleClearJobs = () => {
    localStorage.removeItem("scheduledJobs");
    setScheduledJobs([]);
  };

  return (
    <Page title="Gestione Prodotti">
      <Layout>
        <Layout.Section>
          <Card >
            <FormLayout>
              <BlockStack  >
                <BlockStack align="space-evenly" >
                  <Select
                    label="Ogni"
                    options={everyOptions}
                    value={every}
                    onChange={(value) => setEvery(value)}
                  />
                  <Select
                    label="Periodo"
                    options={periodOptions}
                    value={period}
                    onChange={(value) => setPeriod(value)}
                  />
                </BlockStack>
                <ButtonGroup>
                  <Button variant="primary" onClick={handleUpdateProducts}>
                    Aggiorna Prodotti
                  </Button>
                  <Button onClick={handleScheduleCron}>
                    Schedula Job
                  </Button>
                  <Button onClick={handleClearJobs}>
                    Cancella Tutti i Job
                  </Button>
                </ButtonGroup>
              </BlockStack>
            </FormLayout>
          </Card>
        </Layout.Section>

        <Layout.Section>
          {actionData?.success && actionData.message && (
            <Banner title="Aggiornamento Prodotti" tone="success">
              <p>{actionData.message}</p>
              {actionData.updatedProductsCount !== undefined && (
                <p>Prodotti aggiornati in questo momento: {actionData.updatedProductsCount}</p>
              )}
            </Banner>
          )}
          {actionData?.error && (
            <Banner title="Errore" tone="critical">
              <p>{actionData.error}</p>
            </Banner>
          )}
          {executionMessage && (
            <Banner title="Esecuzione Cron Job" tone="success">
              <p>{executionMessage}</p>
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          {scheduledJobs.length > 0 && (
            <Card>
              {scheduledJobs.map((job) => (
                <Card key={job.id}>
                  <TextContainer>
                    <p>
                      <Text as="strong">Ogni:</Text> {job.every} {job.period}
                    </p>
                    <p>
                      <Text as="strong">Orario di creazione:</Text> {job.time}
                    </p>
                    <Button onClick={() => handleStopJob(job.id)}>Stop Job</Button>
                  </TextContainer>
                </Card>
              ))}
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}