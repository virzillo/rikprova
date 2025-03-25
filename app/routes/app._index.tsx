import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";

type JobHistoryEntry = {
  id: string;
  action: string;
  timestamp: string;
  status: 'success' | 'error';
  details?: string;
  updatedProductsCount?: number;
};

type ScheduledJob = {
  id: string;
  every: string;
  period: string;
  time: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Index() {
  const [stats, setStats] = useState({
    active: 0,
    updatedProducts: 0,
  });

  useEffect(() => {
    // Retrieve job history from local storage
    const storedHistory = localStorage.getItem('jobHistory');
    let parsedHistory: JobHistoryEntry[] = [];

    if (storedHistory) {
      try {
        parsedHistory = JSON.parse(storedHistory);
      } catch (error) {
        console.error("Error parsing job history", error);
      }
    }

    // Retrieve scheduled jobs from local storage
    const storedScheduledJobs = localStorage.getItem('scheduledJobs');
    let parsedScheduledJobs: ScheduledJob[] = [];

    if (storedScheduledJobs) {
      try {
        parsedScheduledJobs = JSON.parse(storedScheduledJobs);
      } catch (error) {
        console.error("Error parsing scheduled jobs", error);
      }
    }

    // Calculate statistics
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentHistory = parsedHistory.filter((entry: JobHistoryEntry) => 
      new Date(entry.timestamp) > last24Hours
    );

    // Sum up total updated products from successful jobs in the last 24 hours
    const totalUpdatedProducts = recentHistory.reduce((total, job) => {
      return total + (job.updatedProductsCount || 0);
    }, 0);

    setStats({
      // Active tasks are currently scheduled jobs
      active: parsedScheduledJobs.length,
      // Total products updated in successful jobs in the last 24 hours
      updatedProducts: totalUpdatedProducts
    });
  }, []);

  return (
    <Page>
      <TitleBar title="QuickEdit: Bulk Edit" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Date range: Last 24 hours
              </Text>
              <InlineStack gap="400">
                <Box>
                  <Text as="span" variant="bodyMd" tone="subdued">Active tasks</Text>
                  <Text as="h1" variant="headingXl">{stats.active}</Text>
                </Box>
                <Box>
                  <Text as="span" variant="bodyMd" tone="success">Updated Products</Text>
                  <Text as="h1" variant="headingXl" tone="success">{stats.updatedProducts}</Text>
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack align="center" gap="400">
              <Box>
                <svg 
                  xmlns="http://www.w3.org/2000/svg" 
                  width="100" 
                  height="100" 
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="12" y1="13" x2="12" y2="17"/>
                  <line x1="10" y1="15" x2="14" y2="15"/>
                </svg>
              </Box>
              <BlockStack gap="200" align="center">
                <Text as="h2" variant="headingMd">
                  Create a new bulk edit task
                </Text>
                <Text as="span" variant="bodyMd" tone="subdued">
                  Create a new bulk edit task to edit your products, variants, or collections.
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                <Button variant="primary">Create bulk edit</Button>
                <Button>View tasks</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}