import { useActionData, useSubmit } from "@remix-run/react";
import {
  Page,
  Card,
  Button,
  Layout,
  DataTable,
  Toast,
  Frame,
  Badge,
  Text,
  ProgressBar,
  Banner,
  Select,
} from "@shopify/polaris";
import {
  RefreshIcon,
  ClockIcon,
  DeleteIcon,
} from "@shopify/polaris-icons";
import { useState, useEffect, useRef } from "react";
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import cron from "node-cron";

// Enhanced job tracking with more metadata
const activeJobs: {
  [key: string]: {
    task: cron.ScheduledTask;
    createdAt: Date;
    totalRatePointsUsed: number;
  };
} = {};

export const action: ActionFunction = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action") as string;

  async function updateProductsWithNoInventory() {
    console.log("Starting product update...");
    const pageSize = 249;
    let hasNextPage = true;
    let cursor = null;
    const updatedProducts: { id: string; status: string }[] = [];
    let totalRatePointsUsed = 0;
    let totalProcessed = 0;
    let totalProducts = 0;

    while (hasNextPage) {
      const searchString: string = cursor
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
                variants(first: 10) {
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

      const responseData = await response.json();

      // Log rate limit information
      const rateLimit = responseData.extensions?.cost?.throttleStatus;
      if (rateLimit) {
        console.log("Rate Limit Information for Products Query:");
        console.log(`Currently Available: ${rateLimit.currentlyAvailable}`);
        console.log(`Maximum Available: ${rateLimit.maximumAvailable}`);
        console.log(
          "Full Extensions Object:",
          JSON.stringify(responseData.extensions, null, 2)
        );

        const requestedQueryPoints =
          rateLimit.maximumAvailable - rateLimit.currentlyAvailable;
        console.log(`Calculated Requested Query Points: ${requestedQueryPoints}`);

        totalRatePointsUsed += requestedQueryPoints;
      }

      const products = responseData.data.products.edges.map((edge: any) => ({
        id: edge.node.id,
        variants: edge.node.variants.edges.map(
          (variantEdge: any) => variantEdge.node
        ),
        status: edge.node.status,
      }));

      totalProducts += products.length;

      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const allVariantsOutOfStock = product.variants.every(
          (variant: any) => variant.inventoryQuantity === 0
        );

        if (allVariantsOutOfStock && product.status !== "DRAFT") {
          try {
            const updateResponse = await admin.graphql(
              `
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
            `,
              {
                variables: {
                  input: {
                    id: product.id,
                    status: "DRAFT",
                  },
                },
              }
            );

            const updateResult = await updateResponse.json();

            // Log rate limit information for mutation
            const updateRateLimit = updateResult.extensions?.cost?.throttleStatus;
            if (updateRateLimit) {
              console.log("Mutation Rate Limit Information:");
              console.log(
                `Currently Available: ${updateRateLimit.currentlyAvailable}`
              );
              console.log(
                `Maximum Available: ${updateRateLimit.maximumAvailable}`
              );
              console.log(
                "Full Mutation Extensions:",
                JSON.stringify(updateResult.extensions, null, 2)
              );

              const mutationRequestedPoints =
                updateRateLimit.maximumAvailable -
                updateRateLimit.currentlyAvailable;
              console.log(
                `Calculated Mutation Requested Points: ${mutationRequestedPoints}`
              );

              totalRatePointsUsed += mutationRequestedPoints;
            }

            if (updateResult.data?.productUpdate?.userErrors?.length > 0) {
              console.error(
                "Update errors:",
                updateResult.data.productUpdate.userErrors
              );
            } else {
              updatedProducts.push({
                id: product.id,
                status: "DRAFT",
              });
            }
          } catch (error) {
            console.error(`Error updating product ${product.id}:`, error);
          }
        }

        totalProcessed++;
      }

      hasNextPage = responseData.data.products.pageInfo.hasNextPage;
      cursor = responseData.data.products.pageInfo.endCursor;
    }

    return {
      success: true,
      message: "Prodotti aggiornati con successo!",
      updatedProductsCount: updatedProducts.length,
      totalProcessed,
      totalRatePointsUsed,
      finalRateLimit: {
        pointsUsed: totalRatePointsUsed,
        pointsRemaining:
          totalRatePointsUsed, // Use the accumulated total rate points used
      },
      totalProducts: totalProducts,
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
        return json(
          {
            success: false,
            error: "Periodo non valido",
          },
          { status: 400 }
        );
    }

    const jobId = `${every}-${period}-${Date.now()}`;

    console.log(`Scheduling cron job with expression: ${cronExpression}`);
    const scheduledJob = cron.schedule(cronExpression, async () => {
      try {
        console.log(`Executing cron job at ${new Date().toLocaleString()}`);
        const result = await updateProductsWithNoInventory();
        console.log(
          `Cron job executed successfully at ${new Date().toLocaleString()}`
        );
        console.log(`Updated ${result.updatedProductsCount} products`);
      } catch (error) {
        console.error("Errore nell'esecuzione del cron job:", error);
      }
    });

    // Store the job in the global activeJobs object with additional metadata
    activeJobs[jobId] = {
      task: scheduledJob,
      createdAt: new Date(),
      totalRatePointsUsed: 0,
    };

    return json({
      success: true,
      message: `Job schedulato: ogni ${every} ${period}`,
      jobId: jobId,
      updatedProductsCount: 0, // Default value
    });
  }

  if (action === "stopJob") {
    const jobId = formData.get("jobId") as string;
  
    if (activeJobs[jobId]) {
      activeJobs[jobId].task.stop();
      delete activeJobs[jobId];
  
      return json({
        success: true,
        message: `Job ${jobId} fermato con successo`,
      });
    }
  
    return json(
      {
        success: false,
        error: "Job non trovato",
      },
      { status: 404 }
    );
  }

  if (action === "runNow") {
    const result = await updateProductsWithNoInventory();
    return json(result);
  }

  return json(
    {
      success: false,
      error: "Azione non riconosciuta",
    },
    { status: 400 }
  );
};

type ScheduledJob = {
  id: string;
  every: string;
  period: string;
  time: string;
  ratePointsUsed?: number;
};

type JobHistoryEntry = {
  id: string;
  action: string;
  timestamp: string;
  status: "success" | "error";
  details?: string;
  updatedProductsCount?: number;
  ratePointsUsed?: number;
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
  const [progress, setProgress] = useState<number>(0);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [currentRateLimit, setCurrentRateLimit] = useState<{
    used: number;
    remaining: number | null;
  } | null>(null);

  useEffect(() => {
    if (actionData?.success) {
      const updatedProductsMessage = actionData.updatedProductsCount
        ? ` - ${actionData.updatedProductsCount} products updated`
        : "";
  
      setToastMessage(`${actionData.message}${updatedProductsMessage}`);
  
      if (actionData.totalProducts > 0) {
        setProgress((actionData.totalProcessed / actionData.totalProducts) * 100);
      }
  
      console.log("Job Execution Details:");
      console.log(`Total Products Processed: ${actionData.totalProcessed}`);
      console.log(`Updated Products: ${actionData.updatedProductsCount}`);
      console.log("Rate Limit Information:");
      console.log(`Total Points Used: ${actionData.totalRatePointsUsed}`);
      console.log(
        `Points Remaining: ${actionData.finalRateLimit?.pointsRemaining}`
      );
  
      const newHistoryEntry: JobHistoryEntry = {
        id: Date.now().toString(),
        action: actionData.jobId ? "Schedule Job" : "Update Products",
        timestamp: new Date().toLocaleString(),
        status: "success",
        details: `Processed: ${actionData.totalProcessed}, Updated: ${
          actionData.updatedProductsCount
        }`,
        updatedProductsCount: actionData.updatedProductsCount || 0,
        ratePointsUsed: actionData.totalRatePointsUsed,
      };
  
      if (actionData.finalRateLimit) {
        setCurrentRateLimit({
          used: actionData.finalRateLimit.pointsUsed,
          remaining: actionData.finalRateLimit.pointsRemaining,
        });
      }
  
      const updatedHistory = [newHistoryEntry, ...jobHistory].slice(0, 10);
      setJobHistory(updatedHistory);
      localStorage.setItem("jobHistory", JSON.stringify(updatedHistory));
  
      if (actionData.jobId) {
        const newJob: ScheduledJob = {
          id: actionData.jobId,
          every: every,
          period: period,
          time: new Date().toLocaleString(),
          ratePointsUsed: actionData.totalRatePointsUsed,
        };
  
        const updatedJobs = [...scheduledJobs, newJob];
        setScheduledJobs(updatedJobs);
        localStorage.setItem("scheduledJobs", JSON.stringify(updatedJobs));
      }
    }
  }, [actionData]);

  const simulateProgress = () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
    }
    setProgress(0);
    progressIntervalRef.current = setInterval(() => {
      setProgress((prevProgress) => {
        const newProgress = prevProgress + 10;
        if (newProgress >= 100) {
          clearInterval(progressIntervalRef.current!);
          return 100;
        }
        return newProgress;
      });
    }, 1000);
  };


  const handleUpdateProducts = () => {
    setProgress(0);
    simulateProgress();

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

    const updatedJobs = scheduledJobs.filter((job) => job.id !== jobId);
    setScheduledJobs(updatedJobs);
    localStorage.setItem("scheduledJobs", JSON.stringify(updatedJobs));
  };

  const handleClearJobs = () => {
    localStorage.removeItem("scheduledJobs");
    setScheduledJobs([]);
  };

  const everyOptions = [
    { label: "1", value: "1" },
    { label: "5", value: "5" },
    { label: "10", value: "10" },
    { label: "15", value: "15" },
    { label: "30", value: "30" },
    { label: "60", value: "60" },
  ];

  const periodOptions = [
    { label: "Minutes", value: "minutes" },
    { label: "Hours", value: "hours" },
    { label: "Days", value: "days" },
  ];

  const isJobLimitReached = scheduledJobs.length >= 3;

  return (
    <Frame>
      <Page
        title="Product Management"
        subtitle="Automate product status updates based on inventory"
      >
        <Layout>


<Layout.Section>
  <Card roundedAbove="sm" >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        <Text as="p" variant="bodyMd" fontWeight="bold">
          Immediately update product statuses based on inventory.
        </Text>
        {actionData?.updatedProductsCount > 0 && (
          <div style={{ marginTop: '10px' }}>
            <Badge tone="success">
              {`${actionData.updatedProductsCount} Products Updated`}
            </Badge>
            <Text as="p" variant="bodySm">
              Total products processed: {actionData.totalProcessed}
            </Text>
          </div>
        )}
      </div>
      <Button
        variant="primary"
        onClick={handleUpdateProducts}
        icon={<RefreshIcon style={{ width: 16, height: 16 }} />}
        size="slim"
      >
        Update Products
      </Button>
    </div>
    <div style={{ marginTop: "10px" }}> <br />
      <ProgressBar progress={progress} />  <br />
      <Text as="p" variant="bodyMd" alignment="center">
        {progress > 0 ? `${progress.toFixed(0)}%` : "No job running"}
      </Text> 
    </div>
    <div style={{ textAlign: "right", marginTop: "10px" }}>
      <Button
        onClick={() => setIsJobHistoryExpanded(!isJobHistoryExpanded)}
        size="slim"
      >
        {isJobHistoryExpanded ? "Hide History" : "View History"}
      </Button>
    </div>
    {isJobHistoryExpanded && (
      <DataTable
        columnContentTypes={["text", "text", "text", "text"]}
        headings={["Action", "Timestamp", "Status", "Details"]}
        rows={jobHistory.map((entry) => [
          entry.action,
          entry.timestamp,
          <Badge tone={entry.status === "success" ? "success" : "critical"}>
            {entry.status}
          </Badge>,
          entry.details || "-",
        ])}
      />
    )}
  </Card>
  <br />
  <Card >
    <Text as="h2" variant="headingMd">Schedule Automated Updates</Text>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "10px" }}>
      <div style={{ display: "flex", gap: "10px" }}>
        <Select label="Every" options={everyOptions} onChange={setEvery} value={every} labelHidden  />
        <Select label="Period" options={periodOptions} onChange={setPeriod} value={period} labelHidden  />
      </div>
      <Button onClick={handleScheduleCron} disabled={isJobLimitReached} icon={<ClockIcon style={{ width: 16, height: 16 }} />} size="slim">
        Schedule Job
      </Button>
    </div>
  </Card>
  <br />
  {scheduledJobs.length > 0 && (
    <Layout.Section>
      <Card >
        <DataTable
          columnContentTypes={["text", "text", "text", "text", "text"]}
          headings={[
            "Job ID",
            "Frequency",
            "Period",
            "Created At",
            "Actions",
          ]}
          rows={scheduledJobs.map((job) => [
            job.id.slice(-6), // Show only last 6 characters
            job.every,
            job.period,
            job.time,
            (
              <Button
                size="slim"
                tone="critical"
                onClick={() => handleStopJob(job.id)}
              >
                Stop
              </Button>
            ),
          ])}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "10px" }}>
          <Button
            variant="primary"
            tone="critical"
            onClick={handleClearJobs}
            icon={<DeleteIcon style={{ width: 16, height: 16 }} />}
            size="slim"
          >
            Clear Jobs
          </Button>
        </div>
      </Card>
    </Layout.Section>
  )}
</Layout.Section>


          {isJobLimitReached && (
            <Layout.Section>
              <Banner title="Job Limit Reached" tone="warning">
                <p>
                  You can only have up to 3 scheduled jobs at a time. Stop an
                  existing job to schedule a new one.
                </p>
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