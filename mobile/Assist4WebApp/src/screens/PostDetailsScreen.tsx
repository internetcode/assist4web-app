import React, { useEffect, useState } from 'react';
import { StyleSheet, ScrollView, Text, View, Alert } from 'react-native';
import { Card, Title } from 'react-native-paper';
import LinearGradient from 'react-native-linear-gradient';
import { ASSIST4WEB_GRADIENT } from '../theme/branding';
import { API_BASE_URL, withApiHeaders } from '../config/network';

type Post = {
  id?: number;
  title?: { rendered?: string };
  content?: { rendered?: string };
  _embedded?: {
    'wp:featuredmedia'?: Array<{
      source_url?: string;
    }>;
  };
};

const PostDetailsScreen = ({ route }: any) => {
  const initialPost: Post | undefined = route?.params?.post;
  const postId = route?.params?.postId;
  const [post, setPost] = useState<Post | null>(initialPost || null);

  useEffect(() => {
    if (!postId || post?.id === Number(postId)) {
      return;
    }

    const fetchPostDetails = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/posts/${postId}`, {
          headers: withApiHeaders(),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data: Post = await response.json();
        setPost(data);
      } catch (error) {
        Alert.alert('Error', 'Failed to fetch post details');
      }
    };

    fetchPostDetails();
  }, [postId, post?.id]);

  const stripHtml = (html?: string): string =>
    html ? html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim() : '';

  const imageUrl = post?._embedded?.['wp:featuredmedia']?.[0]?.source_url;

  return (
    <LinearGradient colors={ASSIST4WEB_GRADIENT} style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Card style={styles.card}>
          {imageUrl ? (
            <Card.Cover source={{ uri: imageUrl }} style={styles.postImage} />
          ) : (
            <View style={styles.imagePlaceholder}>
              <Text style={styles.imagePlaceholderText}>No image</Text>
            </View>
          )}
          <Card.Content>
            <Title style={styles.postTitle}>{stripHtml(post?.title?.rendered)}</Title>
            <Text style={styles.postContent}>{stripHtml(post?.content?.rendered)}</Text>
          </Card.Content>
        </Card>
      </ScrollView>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: 10, paddingBottom: 24 },
  card: { marginVertical: 4 },
  postImage: { height: 220 },
  imagePlaceholder: { height: 220, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ddd' },
  imagePlaceholderText: { fontSize: 13, color: '#666' },
  postTitle: { fontSize: 18, fontWeight: 'bold', marginTop: 10, marginBottom: 8 },
  postContent: { fontSize: 14, color: '#333', lineHeight: 22, paddingBottom: 12 },
});

export default PostDetailsScreen;
