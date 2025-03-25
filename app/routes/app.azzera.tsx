import { useActionData, useSubmit } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  Button,
  Banner,
  Select,
  ButtonGroup,
  Layout,
  DataTable,
  Toast,
  Frame,
  Badge
} from "@shopify/polaris";
import { 
  RefreshIcon, 
  ClockIcon, 
  DeleteIcon 
} from "@shopify/polaris-icons";
import { useState, useEffect } from "react";
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import cron from "node-cron";

// Keep track of active jobs globally
const activeJobs: { [key: string]: cron.ScheduledTask } = {};

export const action: ActionFunction = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action") as string;

  async function updateProductsWithNoInventory() {
    console.log("Starting product update...");
    const pageSize = 250;
    let hasNextPage = true;
    let cursor = null;
    const updatedProducts: { id: string; status: string }[] = [];

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

    console.log("Product update completed.");
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
        cronExpression = `*/${every} * * * *`;
        break;
      case "hours":
        cronExpression = `0 */${every} * * *`;
        break;
      case "days":
        cronExpression = `0 0 */${every} * *`;
        break;
      default:
        return json({ 
          success: false, 
          error: "Periodo non valido" 
        }, { status: 400 });
    }

    const jobId = `${every}-${period}-${Date.now()}`;

    console.log(`Scheduling cron job with expression: ${cronExpression}`);
    const scheduledJob = cron.schedule(cronExpression, async () => {
      try {
        console.log(`Executing cron job at ${new Date().toLocaleString()}`);
        const result = await updateProductsWithNoInventory();
        console.log(`Cron job executed successfully at ${new Date().toLocaleString()}`);
        console.log(`Updated ${result.updatedProductsCount} products`);
      } catch (error) {
        console.error("Errore nell'esecuzione del cron job:", error);
      }
    });

    // Store the job in the global activeJobs object
    activeJobs[jobId] = scheduledJob;

    return json({ 
      success: true, 
      message: `Job schedulato: ogni ${every} ${period}`,
      jobId: jobId,
      updatedProductsCount: 0 // Default value
    });
  }

  if (action === "stopJob") {
    const jobId = formData.get("jobId") as string;
    
    if (activeJobs[jobId]) {
      activeJobs[jobId].stop();
      delete activeJobs[jobId];
      
      return json({ 
        success: true, 
        message: `Job ${jobId} fermato con successo` 
      });
    }

    return json({ 
      success: false, 
      error: "Job non trovato" 
    }, { status: 404 });
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

type JobHistoryEntry = {
  id: string;
  action: string;
  timestamp: string;
  status: 'success' | 'error';
  details?: string;
  updatedProductsCount?: number;
};

export default function AppAzzera() {
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [every, setEvery] = useState<string>("1");
  const [period, setPeriod] = useState<string>("minutes");
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJob[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [jobHistory, setJobHistory] = useState<JobHistoryEntry[]>([]);
  const [isJobHistoryExpanded, setIsJobHistoryExpanded] = useState(false);

  useEffect(() => {
    const storedJobs = localStorage.getItem("scheduledJobs");
    if (storedJobs) {
      setScheduledJobs(JSON.parse(storedJobs));
    }

    const storedHistory = localStorage.getItem('jobHistory');
    if (storedHistory) {
      setJobHistory(JSON.parse(storedHistory));
    }
  }, []);

  useEffect(() => {
    if (actionData?.success) {
      setToastMessage(actionData.message);
      
      // Create a job history entry
      const newHistoryEntry: JobHistoryEntry = {
        id: Date.now().toString(),
        action: actionData.jobId ? 'Schedule Job' : 'Update Products',
        timestamp: new Date().toLocaleString(),
        status: 'success',
        details: actionData.message,
        updatedProductsCount: actionData.updatedProductsCount || 0
      };

      // Update job history
      const updatedHistory = [newHistoryEntry, ...jobHistory].slice(0, 10); // Keep last 10 entries
      setJobHistory(updatedHistory);
      localStorage.setItem('jobHistory', JSON.stringify(updatedHistory));
      
      // If a new job was scheduled, update the jobs list
      if (actionData.jobId) {
        const newJob: ScheduledJob = {
          id: actionData.jobId,
          every: every,
          period: period,
          time: new Date().toLocaleString(),
        };

        const updatedJobs = [...scheduledJobs, newJob];
        setScheduledJobs(updatedJobs);
        localStorage.setItem("scheduledJobs", JSON.stringify(updatedJobs));
      }
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
    { label: "Minutes", value: "minutes" },
    { label: "Hours", value: "hours" },
    { label: "Days", value: "days" }
  ];

  const handleUpdateProducts = () => {
    const formData = new FormData();
    formData.append("action", "runNow");
    submit(formData, { method: "post" });
  };

  const handleScheduleCron = () => {
    let adjustedEvery = every;
    let adjustedPeriod = period;

    if (every === "60" && period === "minutes") {
      adjustedEvery = "1";
      adjustedPeriod = "hours";
    }

    const formData = new FormData();
    formData.append("every", adjustedEvery);
    formData.append("period", adjustedPeriod);
    formData.append("action", "scheduleCron");
    submit(formData, { method: "post" });
  };

  const handleStopJob = (jobId: string) => {
    const formData = new FormData();
    formData.append("jobId", jobId);
    formData.append("action", "stopJob");
    submit(formData, { method: "post" });

    // Remove the job from local state and storage
    const updatedJobs = scheduledJobs.filter(job => job.id !== jobId);
    setScheduledJobs(updatedJobs);
    localStorage.setItem("scheduledJobs", JSON.stringify(updatedJobs));
  };

  const handleClearJobs = () => {
    localStorage.removeItem("scheduledJobs");
    setScheduledJobs([]);
  };

  const isJobLimitReached = scheduledJobs.length >= 3;

  return (
    <Frame>
      <Page 
        title="Product Management" 
        subtitle="Automate product status updates based on inventory"
      >
        <Layout>
          <Layout.Section>
            <Card>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '20px', 
                padding: '20px' 
              }}>
                <div style={{ flex: 1 }}>
                  <Select
                    label="Frequency"
                    helpText="How often should the job run?"
                    options={everyOptions}
                    value={every}
                    onChange={(value) => setEvery(value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Select
                    label="Period"
                    helpText="Select the time unit for job scheduling"
                    options={periodOptions}
                    value={period}
                    onChange={(value) => setPeriod(value)}
                  />
                </div>
              </div>
              
              <Card>
                <ButtonGroup fullWidth>
                  <Button 
                    variant="primary" 
                    onClick={handleUpdateProducts}
                    icon={RefreshIcon}
                  >
                    Update Products Now
                  </Button>
                  <Button 
                    onClick={handleScheduleCron} 
                    disabled={isJobLimitReached}
                    icon={ClockIcon}
                  >
                    Schedule Automated Job
                  </Button>
                  <Button 
                    variant="primary"
                    tone="critical"
                    onClick={handleClearJobs}
                    icon={DeleteIcon}
                  >
                    Clear All Jobs
                  </Button>
                </ButtonGroup>
              </Card>
            </Card>
          </Layout.Section>

          {scheduledJobs.length > 0 && (
            <Layout.Section>
              <Card>
                <div style={{ textAlign: 'right', padding: '10px' }}>
                  <Button
                    variant="primary"
                    tone="critical"
                    onClick={handleClearJobs}
                  >
                    Clear All
                  </Button>
                </div>
                <DataTable
                  columnContentTypes={[
                    'text',
                    'text',
                    'text',
                    'text',
                    'text',
                  ]}
                  headings={[
                    'Job ID',
                    'Frequency',
                    'Period',
                    'Created At',
                    'Actions',
                  ]}
                  rows={scheduledJobs.map((job) => [
                    job.id.slice(-6),  // Show only last 6 characters
                    job.every,
                    job.period,
                    job.time,
                    <Button 
                      size="slim" 
                      tone="critical" 
                      onClick={() => handleStopJob(job.id)}
                    >
                      Stop
                    </Button>,
                  ])}
                />
              </Card>
            </Layout.Section>
          )}

          {jobHistory.length > 0 && (
            <Layout.Section>
              <Card>
                {jobHistory.length > 0 && (
                  <div style={{ textAlign: 'right', padding: '10px' }}>
                    <Button
                      onClick={() => setIsJobHistoryExpanded(!isJobHistoryExpanded)}
                    >
                      {isJobHistoryExpanded ? 'Hide History' : 'View History'}
                    </Button>
                  </div>
                )}
                {isJobHistoryExpanded && (
                  <DataTable
                    columnContentTypes={[
                      'text',
                      'text',
                      'text',
                      'text',
                    ]}
                    headings={[
                      'Action',
                      'Timestamp',
                      'Status',
                      'Details',
                    ]}
                    rows={jobHistory.map((entry) => [
                      entry.action,
                      entry.timestamp,
                      <Badge 
                        tone={entry.status === 'success' ? 'success' : 'critical'}
                      >
                        {entry.status}
                      </Badge>,
                      entry.details || '-',
                    ])}
                  />
                )}
              </Card>
            </Layout.Section>
          )}

          {isJobLimitReached && (
            <Layout.Section>
              <Banner 
                title="Job Limit Reached" 
                tone="warning"
              >
                <p>You can only have up to 3 scheduled jobs at a time. Stop an existing job to schedule a new one.</p>
              </Banner>
            </Layout.Section>
          )}
        </Layout>
      </Page>

      {toastMessage && (
        <Toast
          content={toastMessage}
          onDismiss={() => setToastMessage(null)}
          duration={3000}
        />
      )}
    </Frame>
  );
}