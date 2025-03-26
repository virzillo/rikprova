// app/routes/app.compara.server.tsx
import { json, type ActionFunction } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import * as XLSX from 'xlsx';

// Define TypeScript interfaces for better type safety
interface Product {
  id: string;
  variants: Variant[];
  metafields: Record<string, string>;
  tags: string[];
  status: string;
}

interface Variant {
  barcode: string;
}

export const action: ActionFunction = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const file = formData.get("file") as File;
  const excelColumn = formData.get("excelColumn") as string;
  const fornitoreValue = formData.get("fornitoreValue") as string;
  const tag = formData.get("tag") as string;
  const status = formData.get("status") as string;

  if (!file || !(file instanceof File)) {
    return json({ error: "No file uploaded" }, { status: 400 });
  }

  // Read Excel file
  const fileBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet);

  // Extract values from specified column
  const columnValues = data.map((row: any) => row[excelColumn]);

  let hasNextPage = true;
  let cursor = null;
  const updatedProducts: Array<{ id: string; barcode: string; fornitore: string; tags: string[] }> = [];

  while (hasNextPage) {
    const searchString: string = cursor 
      ? `first: 250, after: "${cursor}"` 
      : `first: 250`;

    try {
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
                metafields(first: 10) {
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

      const responseData = await response.json() as { data: any; errors?: { message: string }[] };
      if (responseData.errors) {
        console.error('GraphQL errors:', responseData.errors);
        break;
      }

      const products: Product[] = responseData.data.products.edges.map((edge: any) => {
        const metafields = edge.node.metafields.edges.reduce((acc: any, metafield: any) => {
          acc[metafield.node.key] = metafield.node.value;
          return acc;
        }, {});

        return {
          ...edge.node,
          metafields,
          variants: edge.node.variants.edges.map((variantEdge: any) => variantEdge.node)
        };
      });

      for (const product of products) {
        const productFornitore = product.metafields['custom.fornitore'];
        
        if (productFornitore === fornitoreValue) {
          const matchingVariant = product.variants.find((variant: Variant) => 
            columnValues.includes(variant.barcode)
          );

          if (matchingVariant) {
            try {
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
                  fornitore: productFornitore,
                  tags: updatedTags
                });
              }
            } catch (error) {
              console.error(`Error updating product ${product.id}:`, error);
            }
          }
        }
      }

      hasNextPage = responseData.data.products.pageInfo.hasNextPage;
      cursor = responseData.data.products.pageInfo.endCursor;

    } catch (error) {
      console.error('Error fetching products:', error);
      break;
    }
  }

  return json({
    success: true,
    message: "File processed and products updated successfully!",
    updatedProductsCount: updatedProducts.length,
    updatedProducts
  });
};

export async function loader() {
    try {
      const { admin } = await authenticate.admin(new Request(''));
  
      const response = await admin.graphql(`
        {
          metafields(first: 10, namespace: "custom", key: "fornitore") {
            edges {
              node {
                value
              }
            }
          }
        }
      `);
  
      const responseData = await response.json() as { data: any; errors?: { message: string }[] };
      console.log('GraphQL response:', responseData); // Log the response to check for errors
  
      if (responseData.errors) {
        console.error('GraphQL errors:', responseData.errors);
        throw new Error('Failed to fetch Fornitore values');
      }
  
      const values = responseData.data.metafields.edges.map((edge: any) => edge.node.value);
      const uniqueFornitoreValues = [...new Set(values)];
      return json({
        fornitoreValues: uniqueFornitoreValues.length > 0 ? uniqueFornitoreValues : ['Luxottica'],
        rawData: responseData
      });
    } catch (error) {
      console.error('Error fetching Fornitore values:', error);
      return json({
        fornitoreValues: ['Luxottica'],
        rawData: null
      });
    }
  }